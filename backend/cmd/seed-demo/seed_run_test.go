package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

// Every seed release has to render against its template with the values given
// in releaseSpecs. A missing required field, such as app-with-config's
// API_KEY, would otherwise first show up as a 400 in the reset Job, on the
// live demo, at 06:00.
//
// Rendering without error is not enough on its own: Render looks each field up
// by exact path and falls back to the default for a key that matches nothing.
// A mistyped or renamed path would quietly deploy the default, and for
// nightly-job-demo that means a working image and no failure showcase. So
// every value key must name a field, and the broken image must really render.
//
// And rendering is not applying. app-with-config's boolean FEATURE_FLAG
// rendered as a YAML bool into ConfigMap data, which the apiserver refuses, so
// the seed release was rejected in CI — and every deploy of that template had
// always been rejected. Every value in a map the API types as map[string]string
// must render as a string.
func TestReleaseSpecs_RenderAgainstTheirTemplates(t *testing.T) {
	for _, r := range releaseSpecs() {
		t.Run(r.Name, func(t *testing.T) {
			found := false
			for _, f := range fixtures.All() {
				if f.Name != r.Template {
					continue
				}
				found = true
				rendered, err := template.Render(f.ResourcesYAML, f.UISpecYAML, r.Values, template.Labels{
					ReleaseName: r.Name, TemplateName: r.Template, TemplateVersion: 1, ReleaseID: r.Name,
				})
				if err != nil {
					t.Fatalf("seed release %s does not render against %s: %v", r.Name, r.Template, err)
				}

				var spec struct {
					Fields []struct {
						Path string `yaml:"path"`
					} `yaml:"fields"`
				}
				if err := yaml.Unmarshal([]byte(f.UISpecYAML), &spec); err != nil {
					t.Fatalf("parse ui-spec of %s: %v", r.Template, err)
				}
				paths := map[string]bool{}
				for _, fl := range spec.Fields {
					paths[fl.Path] = true
				}
				var values map[string]any
				if err := json.Unmarshal(r.Values, &values); err != nil {
					t.Fatalf("values of %s are not a JSON object: %v", r.Name, err)
				}
				for key := range values {
					if !paths[key] {
						t.Errorf("seed value %q of %s matches no field of %s, so Render ignores it", key, r.Name, r.Template)
					}
				}

				if r.Name == "nightly-job-demo" && !strings.Contains(string(rendered), "ghcr.io/does-not-exist/nightly:0.0.0") {
					t.Errorf("nightly-job-demo must render the image that cannot be pulled, or the failure showcase is gone")
				}

				stringMap := map[any]string{"ConfigMap": "data", "Secret": "stringData"}
				dec := yaml.NewDecoder(bytes.NewReader(rendered))
				for {
					var doc map[string]any
					err := dec.Decode(&doc)
					if errors.Is(err, io.EOF) {
						break
					}
					if err != nil {
						t.Fatalf("rendered %s is not YAML: %v", r.Name, err)
					}
					m, _ := doc[stringMap[doc["kind"]]].(map[string]any)
					for k, v := range m {
						if _, ok := v.(string); !ok {
							t.Errorf("%s: %s %s.%s renders as %T, but the API requires a string", r.Name, doc["kind"], stringMap[doc["kind"]], k, v)
						}
					}
				}
			}
			if !found {
				t.Fatalf("seed release %s names template %s, which is not a fixture", r.Name, r.Template)
			}
		})
	}
}

// seederAgainst points a Seeder at a server that answers every release create
// with status and body.
func seederAgainst(t *testing.T, status int, body string) *Seeder {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	c := &apiClient{base: srv.URL, hc: srv.Client(), token: "t"}
	return &Seeder{admin: c, user: c, cluster: "kind", ns: "demo"}
}

// A release that is already there is the ordinary re-run and must stay quiet.
func TestSeederRun_SkipsAReleaseThatAlreadyExists(t *testing.T) {
	s := seederAgainst(t, http.StatusConflict,
		`{"type":"https://kubeport.io/errors/conflict","title":"conflict","status":409,"detail":"release name already exists in this cluster/namespace"}`)

	if err := s.Run(context.Background()); err != nil {
		t.Fatalf("a name clash is an existing seed and should be skipped, got %v", err)
	}
}

// #161: when a visitor's release holds the objects a seed release would
// create, the seed release is refused and never created. Reading that 409 as
// "already seeded" is how the demo would lose a seed release while the reset
// Job reported success.
func TestSeederRun_FailsWhenItsObjectsBelongToSomethingElse(t *testing.T) {
	s := seederAgainst(t, http.StatusConflict,
		`{"type":"https://kubeport.io/errors/resource-conflict","title":"resource-conflict","status":409,"detail":"objects this template creates already exist in namespace \"demo\""}`)

	err := s.Run(context.Background())

	if err == nil || !strings.Contains(err.Error(), "belong to something else") {
		t.Fatalf("want a loud failure naming the ownership conflict, got %v", err)
	}
}
