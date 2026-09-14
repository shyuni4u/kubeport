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

// Issue #369. A template's name is one path segment in every template route and
// the kubeport.io/template label on every object a release creates. A name with
// "/" was created with 201 and then answered 404 everywhere; one that was not a
// label value was created and then refused on every deploy. Creating either is
// refused now, by the rule release names have.

type nameRule struct {
	Pattern   string `yaml:"pattern"`
	MaxLength int    `yaml:"maxLength"`
}

// templateNameRules reads the rule openapi.yaml gives the TemplateName path
// parameter and CreateTemplateRequest.name.
func templateNameRules(t *testing.T) (param, body nameRule) {
	t.Helper()
	b, err := os.ReadFile(specPath)
	require.NoError(t, err, "spec missing at %s", specPath)
	var doc struct {
		Components struct {
			Parameters map[string]struct {
				Schema nameRule `yaml:"schema"`
			} `yaml:"parameters"`
			Schemas map[string]struct {
				Properties map[string]nameRule `yaml:"properties"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	require.NoError(t, yaml.Unmarshal(b, &doc))
	return doc.Components.Parameters["TemplateName"].Schema,
		doc.Components.Schemas["CreateTemplateRequest"].Properties["name"]
}

func (r nameRule) accepts(t *testing.T, name string) bool {
	t.Helper()
	return len(name) <= r.MaxLength && regexp.MustCompile(r.Pattern).MatchString(name)
}

// Every name below gets the same answer from openapi.yaml's pattern and
// maxLength as from what the API actually runs, so the document cannot promise
// a rule the server does not keep, or the other way round.
func TestOpenAPISpec_TemplateNamePatternIsTheRule(t *testing.T) {
	param, body := templateNameRules(t)
	require.NotEmpty(t, param.Pattern, "the TemplateName parameter has no pattern")
	require.NotZero(t, param.MaxLength, "the TemplateName parameter has no maxLength")
	require.Equal(t, param, body, "the path parameter and the create body must say the same")

	label := strings.Repeat("a", 63)
	for _, name := range []string{
		"web-app", "nightly-job", "app-with-config", "Web-App", "a", "0abc", "web.app", "a-.b", "a--b", label,
		"", "my/app", "my app", "..", ".web", "web.", "-web", "web-", "a.-b", "web_app", "웹앱", "web%2Fapp", "a?b", "a#b",
		label + "a", label[:61] + ".b", strings.Repeat("app.", 19) + "app",
	} {
		specSays := param.accepts(t, name)
		serverSays := api.ValidateCreateTemplateName(name) == nil
		require.Equal(t, specSays, serverSays, "%q: openapi.yaml says %v, the server says %v", name, specSays, serverSays)
	}
}

func TestCreateTemplate_RefusesANameNoRouteCanReach(t *testing.T) {
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	for _, name := range []string{"my/app", "my app", "..", "-web", "web_app"} {
		requireTemplateNameRefused(t, admin, name)
	}
}

// A name that could not be a label value would make every deploy of the
// template fail at the apiserver (master and security review).
func TestCreateTemplate_RefusesANameThatCannotBeALabel(t *testing.T) {
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	for _, name := range []string{"web-", strings.Repeat("app.", 19) + "app"} {
		requireTemplateNameRefused(t, admin, name)
	}
}

func requireTemplateNameRefused(t *testing.T, router http.Handler, name string) {
	t.Helper()
	w := do(t, router, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(name)))
	require.Equal(t, http.StatusBadRequest, w.Code, "%q: %s", name, w.Body.String())
	var p struct {
		Title string `json:"title"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Equal(t, "validation-error", p.Title, name)
}

// The demo seeds its catalog under these names; a rule they broke would be a
// rule the live demo already breaks.
func TestTemplateName_TheDemoSeedPasses(t *testing.T) {
	param, _ := templateNameRules(t)
	require.NotEmpty(t, fixtures.All())
	for _, f := range fixtures.All() {
		require.NoError(t, api.ValidateCreateTemplateName(f.Name), f.Name)
		require.True(t, param.accepts(t, f.Name), f.Name)
	}
}
