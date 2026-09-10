package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/template"
)

// Every seed release has to render against its template with the values given
// in releaseSpecs. A missing required field, such as app-with-config's
// API_KEY, would otherwise first show up as a 400 in the reset Job, on the
// live demo, at 06:00.
func TestReleaseSpecs_RenderAgainstTheirTemplates(t *testing.T) {
	for _, r := range releaseSpecs() {
		t.Run(r.Name, func(t *testing.T) {
			found := false
			for _, f := range fixtures.All() {
				if f.Name != r.Template {
					continue
				}
				found = true
				_, err := template.Render(f.ResourcesYAML, f.UISpecYAML, r.Values, template.Labels{
					ReleaseName: r.Name, TemplateName: r.Template, TemplateVersion: 1, ReleaseID: r.Name,
				})
				if err != nil {
					t.Fatalf("seed release %s does not render against %s: %v", r.Name, r.Template, err)
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
// "already seeded" is how the demo would lose web-app-demo while the reset
// Job reported success.
func TestSeederRun_FailsWhenItsObjectsBelongToSomethingElse(t *testing.T) {
	s := seederAgainst(t, http.StatusConflict,
		`{"type":"https://kubeport.io/errors/resource-conflict","title":"resource-conflict","status":409,"detail":"objects this template creates already exist in namespace \"demo\""}`)

	err := s.Run(context.Background())

	if err == nil || !strings.Contains(err.Error(), "belong to something else") {
		t.Fatalf("want a loud failure naming the ownership conflict, got %v", err)
	}
}
