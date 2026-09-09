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

	// sseError is included because the in-stream error frame carries the same
	// ErrorKind vocabulary as an ordinary response (#82). Leaving it out would
	// let a kind reach a client while the spec said nothing about it — the
	// exact drift this file exists to catch.
	re := regexp.MustCompile(`(?:writeError|sseError)\([^,]+,\s*[^,]+,\s*"([a-z0-9-]+)"`)
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
	// Any http.StatusX passed to writeError / c.JSON / c.Status, or carried in
	// a composite verdict value such as accessDenial.
	statusRe = regexp.MustCompile(`(?:writeError\(c,\s*|c\.JSON\(|c\.Status\(|\{)http\.(Status\w+)`)
	// Every top-level func and method, whatever the receiver.
	funcRe = regexp.MustCompile(`(?m)^func (?:\([^)]*\) )?(\w+)\(`)
	// Package-level verdict values such as
	//   denyTeamEditor = &accessDenial{http.StatusForbidden, "rbac-denied", ...}
	// whose status appears in no function body at all.
	verdictRe = regexp.MustCompile(`(?m)^\s*\w+\s*=\s*&?\w+\{(http\.Status\w+).*$`)
	// A function that turns a verdict into a response, rather than passing it
	// back to its caller: `d.write(c)` or `writeError(c, denial.status, ...)`.
	verdictDispatchRe = regexp.MustCompile(`\.write\(c\)|writeError\(c,\s*\w+\.status`)
	// Calls on the Handlers receiver: `h.ensureTemplateEditor(`. Deliberately
	// not `h.deps.Store.GetTemplateVersion(` — several store methods share a
	// name with a handler, and matching those made every route that reads a
	// row inherit the statuses of the handler it is named after.
	methodCallRe = regexp.MustCompile(`\bh\.(\w+)\(`)
	// Package-level calls: `writeError(`, `ownershipOf(`. The leading class
	// keeps out anything reached through a selector, which methodCallRe and
	// verdictDispatchRe cover on their own terms.
	funcCallRe = regexp.MustCompile(`(?:^|[^.\w])(\w+)\(`)
)

// unreachableOnRoute records statuses this guard can see but the route cannot
// actually produce, because the reachability walk is blind to the arguments a
// handler passes. Each entry has to be argued from the code; the alternative is
// documenting a response no client will ever receive, which is the failure this
// spec's review turned up in the first place.
var unreachableOnRoute = map[string]string{
	// GetOpenAPIIndex calls proxyOpenAPI(c, "") and openapiUpstreamSegments
	// returns (nil, nil) for the empty string, so neither the validation nor
	// the prefix assertion below it can fire. The 400 belongs to the sibling
	// route GET /v1/clusters/{name}/openapi/{gv}, where gv is caller-supplied.
	"GET /v1/clusters/:name/openapi 400": "index passes a constant empty gv",
}

var statusNames = map[string]string{
	"StatusOK": "200", "StatusCreated": "201", "StatusNoContent": "204",
	"StatusBadRequest": "400", "StatusUnauthorized": "401", "StatusForbidden": "403",
	"StatusNotFound": "404", "StatusMethodNotAllowed": "405", "StatusConflict": "409",
	"StatusInternalServerError": "500", "StatusBadGateway": "502",
}

// symbolBodies maps every package-level func and method in the api package to
// its source text, cut at the next top-level func, and returns the set of
// statuses carried by package-level verdict values.
//
// Methods share one namespace here regardless of receiver, so two methods with
// the same name on different receivers would merge. That over-approximates —
// the spec is asked to document a status the route may not reach — rather than
// letting a real one slip past. The package has no such pair today.
func symbolBodies(t *testing.T) (map[string]string, map[string]bool) {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	out := map[string]string{}
	verdictCodes := map[string]bool{}
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
		for _, m := range verdictRe.FindAllStringSubmatch(src, -1) {
			if code, known := statusNames[strings.TrimPrefix(m[1], "http.")]; known {
				verdictCodes[code] = true
			}
		}
	}
	require.NotEmpty(t, out, "found no funcs — the regex has stopped matching")
	require.NotEmpty(t, verdictCodes, "found no accessDenial values — the regex has stopped matching")
	return out, verdictCodes
}

// statusesOf returns every status the named symbol can produce: the ones it
// writes itself, plus the ones written by the package functions it calls,
// transitively.
//
// Issue #47 is why it follows calls at all. It moved the template-read 403s
// behind a table of `&accessDenial{http.StatusForbidden, ...}` verdicts, so no
// status literal was left in the handler body and this guard passed while the
// spec went stale — exactly the drift this file exists to prevent.
//
// A verdict's status is counted only in a function that *writes* the verdict
// (`d.write(c)`, `writeError(c, denial.status, ...)`), never in one that
// receives it and decides for itself. That distinction is the rule stated on
// accessDenial in permissions.go, and it is load-bearing here: GetTemplate
// deliberately turns a denial into 404 so the response cannot confirm a
// template the caller may not see. Counting the verdict at the point of
// evaluation would demand a documented 403 that the code refuses to send.
func statusesOf(name string, bodies map[string]string, verdictCodes, seen map[string]bool) map[string]bool {
	out := map[string]bool{}
	if seen[name] {
		return out
	}
	seen[name] = true

	body, ok := bodies[name]
	if !ok {
		return out
	}
	for _, sm := range statusRe.FindAllStringSubmatch(body, -1) {
		if code, known := statusNames[sm[1]]; known {
			out[code] = true
		}
	}
	if verdictDispatchRe.MatchString(body) {
		for code := range verdictCodes {
			out[code] = true
		}
	}

	callees := map[string]bool{}
	for _, re := range []*regexp.Regexp{methodCallRe, funcCallRe} {
		for _, m := range re.FindAllStringSubmatch(body, -1) {
			callees[m[1]] = true
		}
	}
	for callee := range callees {
		if callee == name {
			continue
		}
		if _, known := bodies[callee]; !known {
			continue
		}
		for code := range statusesOf(callee, bodies, verdictCodes, seen) {
			out[code] = true
		}
	}
	return out
}

// Every status a handler can reach must appear in that operation's responses.
// The reverse is deliberately not checked: the auth middleware runs before any
// handler, so its codes belong on operations no handler body leads to.
//
// This is the guard that caught the 204-documented-as-200 and the missing
// 404/409 on POST /v1/releases — and, once it learned to follow references, the
// 403s #47 introduced on the template read paths.
func TestOpenAPISpec_DocumentsEveryStatusHandlersEmit(t *testing.T) {
	bodies, verdicts := symbolBodies(t)
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
	used := map[string]bool{}
	for _, ri := range r.Routes() {
		hm := handlerNameRe.FindStringSubmatch(ri.Handler)
		if hm == nil {
			continue // inline handler, e.g. /healthz
		}
		if _, ok := bodies[hm[1]]; !ok {
			continue
		}
		key := strings.Replace(ri.Method+" "+ri.Path, "/*gv", "/:gv", 1)
		declared := specCodes[key]

		for _, code := range sortedKeys(statusesOf(hm[1], bodies, verdicts, map[string]bool{})) {
			if declared[code] {
				continue
			}
			if _, excused := unreachableOnRoute[key+" "+code]; excused {
				used[key+" "+code] = true
				continue
			}
			problems = append(problems,
				ri.Method+" "+ri.Path+" can return "+code+" (reachable from "+hm[1]+") but the spec does not list it")
		}
	}
	sort.Strings(problems)
	require.Empty(t, problems, "%s is missing responses the handlers can actually return", specPath)

	// An exception that stopped applying is a claim nobody is checking any
	// more — the route may have changed, or the spec may now document the
	// status outright. Either way the entry has to go.
	var stale []string
	for entry := range unreachableOnRoute {
		if !used[entry] {
			stale = append(stale, entry)
		}
	}
	sort.Strings(stale)
	require.Empty(t, stale,
		"unreachableOnRoute excuses statuses that no longer need excusing — delete these entries")
}
