package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// A hidden template must be indistinguishable from one that does not exist,
// on every read route — otherwise a caller probes names and reads the answer's
// shape instead of its body (#238; codex, security and master review). Compared
// on everything a client can branch on: status, type, title and detail.
// request_id is per request and says nothing about the template.

type problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail"`
}

func problemShape(t *testing.T, body string) problem {
	t.Helper()
	var p problem
	require.NoError(t, json.Unmarshal([]byte(body), &p), "not a problem body: %s", body)
	return p
}

// requireLooksMissing asserts every read of hidden answers exactly as the same
// read of a name that does not exist.
func requireLooksMissing(t *testing.T, r http.Handler, hidden string) {
	t.Helper()
	missing := "no-such-template-" + randSuffix()
	for i, rd := range readsOf(hidden) {
		missingRd := readsOf(missing)[i]
		hiddenCode, hiddenBody := readTemplate(t, r, rd)
		missingCode, missingBody := readTemplate(t, r, missingRd)

		require.Equal(t, http.StatusNotFound, hiddenCode, "%s %s: %s", rd.method, rd.path, hiddenBody)
		require.Equal(t, missingCode, hiddenCode,
			"%s: a hidden template answered %d, a missing one %d (%s)", rd.path, hiddenCode, missingCode, missingBody)
		require.Equal(t, problemShape(t, missingBody), problemShape(t, hiddenBody),
			"%s: hidden and missing must carry the same problem", rd.path)
	}
}

// Across the demo line: the operator's published template, read by a demo
// account.
func TestTemplateReads_AcrossTheDemoLineLooksExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	hidden := seedPublishedTemplate(t, adminRouter)

	demoAdmin := demoScopeRouter(t, "demo-admin@"+demoDomain, true)
	requireLooksMissing(t, demoAdmin, hidden)

	// A missing version of a visible template and a version of a hidden one
	// must not differ either.
	visible := seedDemoTemplate(t, s)
	_, missingVersion := readTemplate(t, demoAdmin, templateRead{http.MethodGet, "/v1/templates/" + visible + "/versions/99"})
	_, hiddenVersion := readTemplate(t, demoAdmin, templateRead{http.MethodGet, "/v1/templates/" + hidden + "/versions/1"})
	require.Equal(t, problemShape(t, missingVersion), problemShape(t, hiddenVersion))
}

// A draft of a published template carries a reasoned 403 for callers who can
// see the template. Across the demo line that reason would name the demo rule
// and confirm the template, so the demo line has to be decided first.
func TestTemplateReads_DraftAcrossTheDemoLineLooksExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	hidden := seedPublishedTemplate(t, adminRouter)
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/templates/"+hidden+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	demoAdmin := demoScopeRouter(t, "demo-admin@"+demoDomain, true)
	visible := seedDemoTemplate(t, s)
	_, missingBody := readTemplate(t, demoAdmin, templateRead{http.MethodGet, "/v1/templates/" + visible + "/versions/99"})
	missing := problemShape(t, missingBody)

	for _, rd := range []templateRead{
		{http.MethodGet, "/v1/templates/" + hidden + "/versions/2"},
		{http.MethodPost, "/v1/templates/" + hidden + "/render?version=2"},
	} {
		code, hiddenBody := readTemplate(t, demoAdmin, rd)
		require.Equal(t, http.StatusNotFound, code, "%s %s: %s", rd.method, rd.path, hiddenBody)
		require.Equal(t, missing, problemShape(t, hiddenBody), "%s: the draft must not confirm the template", rd.path)
	}
}

// Never published: a global template only kubeport-admin may read, read by an
// ordinary user. The list hides it, so the item routes — the default render
// path included, which used to say "has no published version" — must too.
func TestTemplateReads_NeverPublishedLooksExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	hidden := seedGlobalTemplate(t, adminRouter) // v1 draft, never published

	requireLooksMissing(t, newPlainUserRouter(t, s, randSuffix()), hidden)
}

// Deleting the only draft leaves a never-published template with no versions
// at all. Whether it is hidden must not hang on it still having a draft.
func TestTemplateReads_NeverPublishedWithoutVersionsLooksExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	hidden := seedGlobalTemplate(t, adminRouter)
	w := do(t, adminRouter, http.MethodDelete, "/v1/templates/"+hidden+"/versions/1", nil)
	require.Less(t, w.Code, 300, w.Body.String())

	requireLooksMissing(t, newPlainUserRouter(t, s, randSuffix()), hidden)
}
