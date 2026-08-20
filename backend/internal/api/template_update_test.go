package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

func TestUpdateTemplate_AdminCanEditGlobal(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	body := map[string]any{
		"display_name": "Renamed Global",
		"tags":         []string{"web", "prod"},
	}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name, bytes.NewReader(raw))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"display_name":"Renamed Global"`)
	require.Contains(t, w.Body.String(), `"tags":["web","prod"]`)
	require.Contains(t, w.Body.String(), `"current_version":`)
	require.Contains(t, w.Body.String(), `"owning_team_name":`)
}

func TestUpdateTemplate_PartialUpdateKeepsUntouchedFields(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r) // display_name="Global Template", tags=["global"]

	// Only update description; display_name + tags must stay.
	body := map[string]any{"description": "new description"}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name, bytes.NewReader(raw))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"description":"new description"`)
	require.Contains(t, w.Body.String(), `"display_name":"Global Template"`)
	require.Contains(t, w.Body.String(), `"tags":["global"]`)
}

func TestUpdateTemplate_EmptyBodyRejected(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	w := do(t, r, http.MethodPatch, "/v1/templates/"+name, bytes.NewReader([]byte(`{}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "no fields to update")
}

func TestUpdateTemplate_EmptyDisplayNameRejected(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	w := do(t, r, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":""}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestUpdateTemplate_WhitespaceDisplayNameRejected(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)

	w := do(t, r, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":"   "}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestUpdateTemplate_NotFound(t *testing.T) {
	r := newTestRouterAdmin(t)
	body := `{"display_name":"x"}`
	w := do(t, r, http.MethodPatch, "/v1/templates/does-not-exist-"+randSuffix(),
		bytes.NewReader([]byte(body)))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestUpdateTemplate_NonAdminDeniedOnGlobal(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

	name := seedGlobalTemplate(t, adminR)

	w := do(t, userR, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":"x"}`)))
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestUpdateTemplate_TeamEditorAllowed(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "patch-" + suffix + "@example.com"
	subject := "stub-patch-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("Patch"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "editor")
	name := seedTemplateOwnedBy(t, adminR, tid)

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":"Team Renamed"}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"display_name":"Team Renamed"`)
}

func TestUpdateTemplate_TeamViewerDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "patchv-" + suffix + "@example.com"
	subject := "stub-patchv-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("PatchV"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "viewer")
	name := seedTemplateOwnedBy(t, adminR, tid)

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":"nope"}`)))
	require.Equal(t, http.StatusForbidden, w.Code)
}

// Classic IDOR shape: editor of team A must not be able to edit a template
// owned by team B, even though they're an editor somewhere. Mirrors
// TestPermissions_CreateTemplate_OtherTeamDenied for the PATCH path.
func TestUpdateTemplate_OtherTeamEditorDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "idor-" + suffix + "@example.com"
	subject := "stub-idor-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("Idor"),
	})
	require.NoError(t, err)

	teamA := createTeam(t, adminR, "team-a-"+randSuffix())
	teamB := createTeam(t, adminR, "team-b-"+randSuffix())
	addMember(t, adminR, teamA, email, "editor")
	name := seedTemplateOwnedBy(t, adminR, teamB)

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"display_name":"hacked"}`)))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

func TestUpdateTemplate_ClearTagsWithEmptyArray(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r) // starts with tags=["global"]

	// Send explicit empty array to clear tags.
	w := do(t, r, http.MethodPatch, "/v1/templates/"+name,
		bytes.NewReader([]byte(`{"tags":[]}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"tags":[]`)
}
