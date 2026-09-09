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

// --- status codes -----------------------------------------------------------

var (
	// "kubeport/internal/api.(*Handlers).CreateRelease-fm" -> "CreateRelease"
	handlerNameRe = regexp.MustCompile(`\(\*Handlers\)\.(\w+)`)
	// Any http.StatusX passed to writeError / c.JSON / c.Status.
	statusRe = regexp.MustCompile(`(?:writeError\(c,\s*|c\.JSON\(|c\.Status\()http\.(Status\w+)`)
	funcRe   = regexp.MustCompile(`(?m)^func \(h \*Handlers\) (\w+)\(`)
)

var statusNames = map[string]string{
	"StatusOK": "200", "StatusCreated": "201", "StatusNoContent": "204",
	"StatusBadRequest": "400", "StatusUnauthorized": "401", "StatusForbidden": "403",
	"StatusNotFound": "404", "StatusMethodNotAllowed": "405", "StatusConflict": "409",
	"StatusInternalServerError": "500", "StatusBadGateway": "502",
}

// handlerBodies maps a handler method name to its source text, cut at the next
// top-level func. Codes emitted by helpers the handler calls are not included,
// which is why the assertion below is one-directional.
func handlerBodies(t *testing.T) map[string]string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	out := map[string]string{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src := readSourceFile(t, f)
		locs := funcRe.FindAllStringSubmatchIndex(src, -1)
		for i, loc := range locs {
			name := src[loc[2]:loc[3]]
			end := len(src)
			if i+1 < len(locs) {
				end = locs[i+1][0]
			}
			out[name] = src[loc[0]:end]
		}
	}
	return out
}

// Every status a handler can return itself must appear in that operation's
// responses. The reverse is deliberately not checked: shared helpers
// (resolveTemplateVersion, requireDeployableVersion, the auth middleware) emit
// codes that never appear in the handler's own body, and documenting those is
// correct.
//
// This is the guard that would have caught the 204-documented-as-200 and the
// missing 404/409 on POST /v1/releases.
func TestOpenAPISpec_DocumentsEveryStatusHandlersEmit(t *testing.T) {
	bodies := handlerBodies(t)
	doc := loadSpec(t)
	brace := regexp.MustCompile(`\{([^}]+)\}`)

	// spec responses keyed by "METHOD /gin/path"
	specCodes := map[string]map[string]bool{}
	for path, item := range doc.Paths {
		ginPath := brace.ReplaceAllString(path, ":$1")
		for method, op := range item {
			m, ok := op.(map[string]any)
			if !ok {
				continue
			}
			resp, ok := m["responses"].(map[string]any)
			if !ok {
				continue
			}
			codes := map[string]bool{}
			for code := range resp {
				codes[code] = true
			}
			specCodes[strings.ToUpper(method)+" "+ginPath] = codes
		}
	}

	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	var problems []string
	for _, ri := range r.Routes() {
		hm := handlerNameRe.FindStringSubmatch(ri.Handler)
		if hm == nil {
			continue // inline handler, e.g. /healthz
		}
		body, ok := bodies[hm[1]]
		if !ok {
			continue
		}
		key := strings.Replace(ri.Method+" "+ri.Path, "/*gv", "/:gv", 1)
		declared := specCodes[key]

		for _, sm := range statusRe.FindAllStringSubmatch(body, -1) {
			code, known := statusNames[sm[1]]
			if !known {
				continue
			}
			if !declared[code] {
				problems = append(problems,
					ri.Method+" "+ri.Path+" returns "+code+" (http."+sm[1]+" in "+hm[1]+") but the spec does not list it")
			}
		}
	}
	sort.Strings(problems)
	require.Empty(t, problems, "%s is missing responses the handlers can actually return", specPath)
}
