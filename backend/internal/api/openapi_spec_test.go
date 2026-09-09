package api_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// backend/api/openapi.yaml is written by hand — Gin carries no type
// information to generate it from. A hand-written spec rots silently, so these
// tests pin the two things that actually break a client when they drift: the
// set of routes, and the set of error kinds.
//
// They are deliberately structural. Nothing here checks that a description is
// accurate; that still needs a human.

const specPath = "../../api/openapi.yaml"

type openapiDoc struct {
	Paths      map[string]map[string]any `yaml:"paths"`
	Components struct {
		Schemas map[string]struct {
			Enum []string `yaml:"enum"`
		} `yaml:"schemas"`
	} `yaml:"components"`
}

func loadSpec(t *testing.T) openapiDoc {
	t.Helper()
	b, err := os.ReadFile(specPath)
	require.NoError(t, err, "spec missing at %s", specPath)

	var doc openapiDoc
	require.NoError(t, yaml.Unmarshal(b, &doc))
	return doc
}

// specOperations returns "METHOD /path" for every operation in the spec, with
// OpenAPI's {braces} rewritten to Gin's :colon form.
func specOperations(t *testing.T) map[string]bool {
	t.Helper()
	brace := regexp.MustCompile(`\{([^}]+)\}`)

	out := map[string]bool{}
	for path, item := range loadSpec(t).Paths {
		ginPath := brace.ReplaceAllString(path, ":$1")
		for method := range item {
			switch method {
			case "get", "post", "put", "patch", "delete":
				out[strings.ToUpper(method)+" "+ginPath] = true
			}
		}
	}
	return out
}

// routerOperations asks Gin itself what it serves, so the test cannot drift
// from the router the way a hard-coded list would.
func routerOperations(t *testing.T) map[string]bool {
	t.Helper()
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})

	out := map[string]bool{}
	for _, ri := range r.Routes() {
		out[ri.Method+" "+ri.Path] = true
	}
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestOpenAPISpec_CoversEveryRoute(t *testing.T) {
	spec, router := specOperations(t), routerOperations(t)

	var missing []string
	for _, op := range sortedKeys(router) {
		// Gin registers the wildcard as /*gv; the spec names the parameter.
		normalised := strings.Replace(op, "/*gv", "/:gv", 1)
		if !spec[normalised] {
			missing = append(missing, op)
		}
	}
	require.Empty(t, missing,
		"these routes exist but are not in %s — document them, or the spec lies about what the API offers", specPath)
}

func TestOpenAPISpec_DocumentsNoRouteThatIsGone(t *testing.T) {
	spec, router := specOperations(t), routerOperations(t)

	var stale []string
	for _, op := range sortedKeys(spec) {
		if router[op] || router[strings.Replace(op, "/:gv", "/*gv", 1)] {
			continue
		}
		stale = append(stale, op)
	}
	require.Empty(t, stale,
		"%s documents routes the router no longer serves — a client would call these and get 404", specPath)
}

// kindsEmittedByHandlers reads the error kinds straight out of the writeError
// calls, so the comparison below is against what the code actually does rather
// than against a second hand-maintained list.
func kindsEmittedByHandlers(t *testing.T) map[string]bool {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	re := regexp.MustCompile(`writeError\([^,]+,\s*[^,]+,\s*"([a-z0-9-]+)"`)
	out := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		for _, m := range re.FindAllStringSubmatch(string(b), -1) {
			out[m[1]] = true
		}
	}
	require.NotEmpty(t, out, "found no writeError calls — the regex has stopped matching")
	return out
}

// The ErrorKind enum is what a client branches on, so it has to name exactly
// the kinds the handlers can produce: a missing one is an unhandled branch, an
// extra one is a branch that will never fire.
func TestOpenAPISpec_ErrorKindsMatchHandlers(t *testing.T) {
	enum := loadSpec(t).Components.Schemas["ErrorKind"].Enum
	require.NotEmpty(t, enum, "ErrorKind enum missing from %s", specPath)

	inSpec := map[string]bool{}
	for _, k := range enum {
		inSpec[k] = true
	}
	emitted := kindsEmittedByHandlers(t)

	for kind := range emitted {
		require.True(t, inSpec[kind],
			"handlers emit error kind %q but the spec's ErrorKind enum omits it — a client cannot branch on it", kind)
	}
	for _, kind := range enum {
		require.True(t, emitted[kind],
			"the spec's ErrorKind enum lists %q, which no handler emits — remove it, or the client writes dead code", kind)
	}
}

func TestOpenAPISpec_LivesWhereTheDocsSayItDoes(t *testing.T) {
	abs, err := filepath.Abs(specPath)
	require.NoError(t, err)
	require.FileExists(t, abs)
}
