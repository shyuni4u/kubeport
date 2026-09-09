package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// Template *writes* have always been gated by ensureTemplateEditor, but the
// read path had no authorization at all: any authenticated user could pull the
// full resources.yaml of any template, including drafts that were never
// published. See issue #12.

// newPlainUserRouter authenticates as an ordinary user — no kubeport-admin
// group, no team membership.
func newPlainUserRouter(t *testing.T, s *store.Store, suffix string) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "outsider-" + suffix,
			Email:   "outsider-" + suffix + "@example.com",
		}},
		Store: s,
	})
}

func TestGetTemplateVersion_DraftRequiresEditor(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter) // v1 starts as draft
	userRouter := newPlainUserRouter(t, s, randSuffix())

	w := do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "resources_yaml")

	// The author still reads their own draft.
	w = do(t, adminRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "resources_yaml")

	// Once published it is catalog content and everyone may read it.
	publishV1(t, adminRouter, tplName)
	w = do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestListTemplateVersions_HidesDraftsFromNonEditors(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedPublishedTemplate(t, adminRouter) // v1 published

	// v2 is an unpublished draft.
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/templates/"+tplName+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	userRouter := newPlainUserRouter(t, s, randSuffix())
	w = do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []int{1}, versionNumbers(t, w.Body.Bytes()))

	w = do(t, adminRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []int{2, 1}, versionNumbers(t, w.Body.Bytes()))
}

func TestPreviewRender_DraftVersionRequiresEditor(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter) // v1 draft
	userRouter := newPlainUserRouter(t, s, randSuffix())

	body, _ := json.Marshal(map[string]any{"values": demoValues})
	w := do(t, userRouter, http.MethodPost, "/v1/templates/"+tplName+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "rendered_yaml")

	w = do(t, adminRouter, http.MethodPost, "/v1/templates/"+tplName+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestListTemplates_HidesNeverPublishedTemplatesFromNonEditors(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	draftOnly := seedGlobalTemplate(t, adminRouter)
	published := seedPublishedTemplate(t, adminRouter)

	userRouter := newPlainUserRouter(t, s, randSuffix())
	w := do(t, userRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), published)
	require.NotContains(t, w.Body.String(), draftOnly)

	w = do(t, adminRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), draftOnly)
}

// The demo scope rule already stops a demo admin from *editing* a real
// operator's template (TestDemoAdmin_CannotEditNonDemoOwnedTemplate); reading
// its draft must be blocked by the same rule.
func TestDemoAdmin_CannotReadNonDemoOwnedTemplateDraft(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter)

	demoRouter := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	w := do(t, demoRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "demo-restricted")
}

// versionNumbers extracts the `version` field of every row in a
// {"versions": [...]} response, preserving order.
func versionNumbers(t *testing.T, raw []byte) []int {
	t.Helper()
	var resp struct {
		Versions []struct {
			Version int `json:"version"`
		} `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(raw, &resp))
	out := make([]int, 0, len(resp.Versions))
	for _, v := range resp.Versions {
		out = append(out, v.Version)
	}
	return out
}
