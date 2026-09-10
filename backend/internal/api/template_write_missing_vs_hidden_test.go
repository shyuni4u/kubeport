package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// Issue #244. #238 made every read route answer a template the caller may not
// see the way it answers a name that does not exist. The write routes still
// told the two apart — authorization ran before anything else, so a 403 meant
// "it exists" and a 404 "it does not", and the 403's detail even said whether
// it was a global or a team template. A write to a template the caller cannot
// see must now look exactly like a write to a missing one; the reasoned 403 is
// kept for callers who can see the template but may not change it.

type templateWrite struct {
	method, path string
	body         any
}

// writesOf lists every route that changes a template, gated by
// ensureTemplateEditor.
func writesOf(name string) []templateWrite {
	base := "/v1/templates/" + name
	version := map[string]any{
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	}
	return []templateWrite{
		{http.MethodPatch, base, map[string]any{"display_name": "renamed"}},
		{http.MethodPost, base + "/versions", version},
		{http.MethodPatch, base + "/versions/1", map[string]any{"resources_yaml": minimalResources}},
		{http.MethodDelete, base + "/versions/1", nil},
		{http.MethodPost, base + "/versions/1/publish", nil},
		{http.MethodPost, base + "/versions/1/deprecate", nil},
		{http.MethodPost, base + "/versions/1/undeprecate", nil},
	}
}

func writeTemplate(t *testing.T, r http.Handler, wr templateWrite) (int, string) {
	t.Helper()
	if wr.body == nil {
		w := do(t, r, wr.method, wr.path, nil)
		return w.Code, w.Body.String()
	}
	b, err := json.Marshal(wr.body)
	require.NoError(t, err)
	w := do(t, r, wr.method, wr.path, bytes.NewReader(b))
	return w.Code, w.Body.String()
}

// writeProblem is the problem a client can branch on, with the template's own
// name taken out of the detail: the missing-name answer echoes the name the
// caller sent, which is not a signal.
func writeProblem(t *testing.T, body, name string) problem {
	t.Helper()
	p := problemShape(t, body)
	p.Detail = strings.ReplaceAll(p.Detail, name, "<name>")
	return p
}

// requireWritesLookMissing asserts every write to hidden answers exactly as the
// same write to a name that does not exist.
func requireWritesLookMissing(t *testing.T, r http.Handler, hidden string) {
	t.Helper()
	missing := "no-such-template-" + randSuffix()
	for i, wr := range writesOf(hidden) {
		missingWr := writesOf(missing)[i]
		hiddenCode, hiddenBody := writeTemplate(t, r, wr)
		missingCode, missingBody := writeTemplate(t, r, missingWr)

		require.Equal(t, http.StatusNotFound, hiddenCode, "%s %s: %s", wr.method, wr.path, hiddenBody)
		require.Equal(t, missingCode, hiddenCode,
			"%s %s: a hidden template answered %d, a missing one %d (%s)", wr.method, wr.path, hiddenCode, missingCode, missingBody)
		require.Equal(t, writeProblem(t, missingBody, missing), writeProblem(t, hiddenBody, hidden),
			"%s %s: hidden and missing must carry the same problem", wr.method, wr.path)
	}
}

func TestTemplateWrites_AcrossTheDemoLineLookExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	t.Run("demo admin writing the operator's template", func(t *testing.T) {
		operatorTpl := seedPublishedTemplate(t, adminRouter)
		requireWritesLookMissing(t, demoScopeRouter(t, "demo-admin@"+demoDomain, true), operatorTpl)
	})
	t.Run("real user writing a demo template", func(t *testing.T) {
		demoTpl := seedDemoTemplate(t, s)
		requireWritesLookMissing(t, demoScopeRouter(t, "real-"+randSuffix()+"@example.com", false), demoTpl)
	})
}

// Never published and not the caller's to read: the list, the item reads and
// now the writes all say it does not exist.
func TestTemplateWrites_NeverPublishedLookExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	hidden := seedGlobalTemplate(t, adminRouter)

	requireWritesLookMissing(t, newPlainUserRouter(t, s, randSuffix()), hidden)
}

// A published template is in everyone's catalog, so saying why a write is
// refused gives nothing away — and tells the caller what they are missing.
func TestTemplateWrites_VisibleTemplateKeepsItsReason(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	visible := seedPublishedTemplate(t, adminRouter)
	user := newPlainUserRouter(t, s, randSuffix())

	for _, wr := range writesOf(visible) {
		code, body := writeTemplate(t, user, wr)
		require.Equal(t, http.StatusForbidden, code, "%s %s: %s", wr.method, wr.path, body)
		require.Contains(t, body, "global template requires kubeport-admin", "%s %s", wr.method, wr.path)
	}
}
