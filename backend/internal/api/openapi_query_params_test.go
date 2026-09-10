package api_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The spec's query parameters are what a generated client, an MCP tool
// description or an agent reads to learn how to call an endpoint, and nothing
// held them to the handlers.
//
// The other guards in this package pin routes, error kinds, statuses and SSE
// event names. Query parameters were the axis left open, and it is the axis #74
// was about: a documented filter the handler never read. #107 added `since`
// and doubled this endpoint's parameters, which is when the gap started to
// matter here — and running this guard for the first time found `verbose` on
// /healthz, read by the handler since the catalog gauge went in and never
// documented.
//
// This compares the two sets for the whole package, not per operation. A
// parameter documented on the wrong route passes it. That is a real limit and
// a narrower one than the gap it closes: the common failures — renaming a
// parameter, deleting one, reading a new one without writing it down — all
// change the set.

var queryReads = regexp.MustCompile(`c\.(?:Default|Get)?Query(?:Array|Map)?\(\s*"([a-z_]+)"`)

// queryParamsRead collects every query parameter a non-test source file reads.
func queryParamsRead(t *testing.T) map[string]bool {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	out := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		for _, m := range queryReads.FindAllStringSubmatch(string(b), -1) {
			out[m[1]] = true
		}
	}
	require.NotEmpty(t, out, "found no c.Query calls — the regex has stopped matching")
	return out
}

// queryParamsDocumented collects every `in: query` parameter the spec declares,
// at operation level and at path-item level.
func queryParamsDocumented(t *testing.T) map[string]bool {
	t.Helper()
	out := map[string]bool{}

	collect := func(raw any) {
		list, ok := raw.([]any)
		if !ok {
			return
		}
		for _, p := range list {
			m, ok := p.(map[string]any)
			if !ok {
				continue
			}
			// A $ref would need resolving against components.parameters. None
			// of the spec's query parameters is referenced today — the shared
			// ones are all path parameters — so an unresolved ref here is a
			// shape this guard has not been taught, and it should say so
			// rather than quietly skip it.
			if ref, isRef := m["$ref"].(string); isRef {
				require.NotContains(t, ref, "Query",
					"a referenced query parameter (%s) — teach queryParamsDocumented to resolve it", ref)
				continue
			}
			if m["in"] == "query" {
				if name, ok := m["name"].(string); ok {
					out[name] = true
				}
			}
		}
	}

	for _, item := range loadSpec(t).Paths {
		for key, op := range item {
			if key == "parameters" {
				collect(op)
				continue
			}
			if opMap, ok := op.(map[string]any); ok {
				collect(opMap["parameters"])
			}
		}
	}
	require.NotEmpty(t, out, "found no query parameters in %s", specPath)
	return out
}

func TestOpenAPISpec_DocumentsEveryQueryParam(t *testing.T) {
	documented := queryParamsDocumented(t)
	var missing []string
	for _, name := range sortedKeys(queryParamsRead(t)) {
		if !documented[name] {
			missing = append(missing, name)
		}
	}
	require.Empty(t, missing,
		"handlers read these query parameters but %s does not declare them — a caller cannot send what it was never told exists", specPath)
}

func TestOpenAPISpec_DocumentsNoQueryParamThatIsIgnored(t *testing.T) {
	read := queryParamsRead(t)
	var ignored []string
	for _, name := range sortedKeys(queryParamsDocumented(t)) {
		if !read[name] {
			ignored = append(ignored, name)
		}
	}
	require.Empty(t, ignored,
		"%s declares query parameters no handler reads — a caller would send them and be silently ignored (#74)", specPath)
}
