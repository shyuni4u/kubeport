package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/api"
	"kubeport/internal/config"
)

// Issue #369. A template's name is one path segment in every template route.
// A name with "/" was created with 201 and then answered 404 everywhere — no
// route could read, change, deploy or delete it — so creating one is refused,
// by the rule release names have.

// templateNamePatterns reads the pattern openapi.yaml gives the TemplateName
// path parameter and the one on CreateTemplateRequest.name.
func templateNamePatterns(t *testing.T) (param, body string) {
	t.Helper()
	b, err := os.ReadFile(specPath)
	require.NoError(t, err, "spec missing at %s", specPath)
	var doc struct {
		Components struct {
			Parameters map[string]struct {
				Schema struct {
					Pattern string `yaml:"pattern"`
				} `yaml:"schema"`
			} `yaml:"parameters"`
			Schemas map[string]struct {
				Properties map[string]struct {
					Pattern string `yaml:"pattern"`
				} `yaml:"properties"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	require.NoError(t, yaml.Unmarshal(b, &doc))
	return doc.Components.Parameters["TemplateName"].Schema.Pattern,
		doc.Components.Schemas["CreateTemplateRequest"].Properties["name"].Pattern
}

// Every name below gets the same answer from openapi.yaml's pattern as from
// the binding the API actually runs, so the document cannot promise a rule the
// server does not keep, or the other way round.
func TestOpenAPISpec_TemplateNamePatternIsTheBinding(t *testing.T) {
	param, body := templateNamePatterns(t)
	require.NotEmpty(t, param, "the TemplateName parameter has no pattern")
	require.Equal(t, param, body, "the path parameter and the create body must say the same")
	re := regexp.MustCompile(param)

	label := strings.Repeat("a", 63)
	for _, name := range []string{
		"web-app", "nightly-job", "app-with-config", "Web-App", "a", "0abc", "web.app", "web-",
		label, label + ".b", label + "a",
		"", "my/app", "my app", "..", ".web", "web.", "-web", "web_app", "웹앱", "web%2Fapp", "a?b", "a#b",
	} {
		specSays := re.MatchString(name)
		bindingSays := api.ValidateCreateTemplateName(name) == nil
		require.Equal(t, specSays, bindingSays, "%q: openapi.yaml says %v, the binding says %v", name, specSays, bindingSays)
	}
}

func TestCreateTemplate_RefusesANameNoRouteCanReach(t *testing.T) {
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	for _, name := range []string{"my/app", "my app", "..", "-web", "web_app"} {
		w := do(t, admin, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(name)))
		require.Equal(t, http.StatusBadRequest, w.Code, "%q: %s", name, w.Body.String())
		var p struct {
			Title string `json:"title"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
		require.Equal(t, "validation-error", p.Title, name)
	}
}

// The demo seeds its catalog under these names; a rule they broke would be a
// rule the live demo already breaks.
func TestTemplateName_TheDemoSeedPasses(t *testing.T) {
	param, _ := templateNamePatterns(t)
	re := regexp.MustCompile(param)
	require.NotEmpty(t, fixtures.All())
	for _, f := range fixtures.All() {
		require.NoError(t, api.ValidateCreateTemplateName(f.Name), f.Name)
		require.True(t, re.MatchString(f.Name), f.Name)
	}
}
