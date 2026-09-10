package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// TestUpdateDraftTemplateVersion_Yaml covers the happy path: an admin edits
// a YAML-mode draft in place, the PATCH succeeds, and the new content is
// observable via GET. This is the save target for the YAML editor.
func TestUpdateDraftTemplateVersion_Yaml(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	updated := `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 5
  template:
    spec:
      containers:
        - name: app
          image: placeholder
`
	body, _ := json.Marshal(map[string]any{"resources_yaml": updated})
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name+"/versions/1", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, "body=%s", w.Body.String())

	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `replicas: 5`, "persisted YAML should reflect PATCH")
}

// TestUpdateDraftTemplateVersion_ConflictWhenPublished ensures we can't patch
// a published version — the backend must treat it as immutable. The editor
// uses this 409 to force the user to create a new draft instead.
func TestUpdateDraftTemplateVersion_ConflictWhenPublished(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)
	publishV1(t, r, name)

	body, _ := json.Marshal(map[string]any{"resources_yaml": minimalResources})
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name+"/versions/1", bytes.NewReader(body))
	require.Equal(t, http.StatusConflict, w.Code, "body=%s", w.Body.String())
	require.Contains(t, w.Body.String(), "only drafts can be updated")
}

// TestUpdateDraftTemplateVersion_YamlRejectsUIState guards the
// authoring_mode / payload consistency check: a yaml-mode draft can't be
// patched with ui_state (and vice versa).
func TestUpdateDraftTemplateVersion_YamlRejectsUIState(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	body, _ := json.Marshal(map[string]any{
		"ui_state": map[string]any{"resources": []any{}},
	})
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name+"/versions/1", bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, "body=%s", w.Body.String())
	require.Contains(t, w.Body.String(), "must not receive ui_state")
}

// TestDeleteDraftTemplateVersion_HappyPath: admin can delete a draft that
// nothing depends on.
func TestDeleteDraftTemplateVersion_HappyPath(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	w := do(t, r, http.MethodDelete, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusNoContent, w.Code, "body=%s", w.Body.String())

	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusNotFound, w.Code)
}

// TestDeleteDraftTemplateVersion_ConflictWhenPublished: published versions are
// immutable — deletion returns 409, not 500. The FK would catch this anyway
// (releases point at versions with ON DELETE RESTRICT) but we want the nicer
// error shape for drafts that happen to be published already.
func TestDeleteDraftTemplateVersion_ConflictWhenPublished(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)
	publishV1(t, r, name)

	w := do(t, r, http.MethodDelete, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusConflict, w.Code, "body=%s", w.Body.String())
	require.Contains(t, w.Body.String(), "only drafts can be deleted")
}

// TestUpdateDraftTemplateVersion_NonAdminGlobalDenied: non-admin can't patch
// a global template's draft. Mirrors the guard on CreateTemplateVersion /
// PublishVersion — ensureTemplateEditor is the single source of truth.
func TestUpdateDraftTemplateVersion_NonAdminGlobalDenied(t *testing.T) {
	// Share one store across admin + non-admin routers so both see the same
	// seeded template — newTestRouterAdmin(t) would create a fresh store.
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
	}
	s, err := store.NewStore(context.Background(), dsn)
	require.NoError(t, err)
	t.Cleanup(s.Close)

	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	name := seedGlobalTemplate(t, admin)

	aliceV := customVerifier{claims: auth.Claims{Subject: "alice-" + randSuffix(), Email: "alice@example.com"}}
	nonAdmin := api.NewRouter(config.Config{}, api.Deps{Verifier: aliceV, Store: s})

	body, _ := json.Marshal(map[string]any{"resources_yaml": minimalResources})
	w := do(t, nonAdmin, http.MethodPatch, "/v1/templates/"+name+"/versions/1", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, "body=%s", w.Body.String())
	require.Contains(t, w.Body.String(), "not-found")
}
