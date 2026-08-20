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

// createTplBody returns a JSON body for POST /v1/templates with the given
// optional owning_team_id (empty = global template).
func createTplBody(t *testing.T, namePrefix, owningTeamID string) []byte {
	t.Helper()
	body := map[string]any{
		"name":           namePrefix + "-" + randSuffix(),
		"display_name":   namePrefix,
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	}
	if owningTeamID != "" {
		body["owning_team_id"] = owningTeamID
	}
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	return raw
}

// TestPermissions_GlobalTemplate_NonAdminDenied verifies that non-admins
// cannot mutate global templates (those with owning_team_id NULL).
func TestPermissions_GlobalTemplate_NonAdminDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

	name := seedGlobalTemplate(t, adminR)

	// Non-admin attempts to deprecate the global template.
	w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusForbidden, w.Code)
}

// TestPermissions_TeamTemplate_EditorAllowed verifies that team editors
// can mutate templates owned by their team.
func TestPermissions_TeamTemplate_EditorAllowed(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	// Create a user and add them as an editor to a team.
	suffix := randSuffix()
	userEmail := "alice-" + suffix + "@example.com"
	userSubject := "stub-" + suffix

	// Create the user in the database directly so they exist before adding to team
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: userSubject,
		Email:       store.PgText(userEmail),
		DisplayName: store.PgText("Alice"),
	})
	require.NoError(t, err)

	// Create a router with the user's credentials
	userVerifier := customVerifier{claims: auth.Claims{Subject: userSubject, Email: userEmail, Name: "Alice"}}
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: userVerifier, Store: s})

	// Create a team as admin and add alice as editor
	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, userEmail, "editor")

	// Create a team-owned template as admin
	name := seedTemplateOwnedBy(t, adminR, tid)
	publishV1(t, adminR, name)

	// Alice (editor) attempts to deprecate the template.
	w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// TestPermissions_CreateTemplate_TeamEditorAllowed verifies a team editor
// can create a template owned by their team (admin role not required).
func TestPermissions_CreateTemplate_TeamEditorAllowed(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "alice-" + suffix + "@example.com"
	subject := "stub-ce-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("Alice"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "editor")

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPost, "/v1/templates", bytes.NewReader(createTplBody(t, "ce", tid)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}

// TestPermissions_CreateTemplate_ViewerDenied verifies a team viewer cannot
// create a template owned by their team.
func TestPermissions_CreateTemplate_ViewerDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "view-" + suffix + "@example.com"
	subject := "stub-cv-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("Viewer"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "viewer")

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPost, "/v1/templates", bytes.NewReader(createTplBody(t, "cv", tid)))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

// TestPermissions_CreateTemplate_OtherTeamDenied verifies that an editor of
// team A cannot create a template owned by team B (IDOR prevention).
func TestPermissions_CreateTemplate_OtherTeamDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "cross-" + suffix + "@example.com"
	subject := "stub-co-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("X"),
	})
	require.NoError(t, err)

	teamA := createTeam(t, adminR, "team-a-"+randSuffix())
	teamB := createTeam(t, adminR, "team-b-"+randSuffix())
	addMember(t, adminR, teamA, email, "editor")

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	// Editor of teamA tries to create a template owned by teamB.
	w := do(t, userR, http.MethodPost, "/v1/templates", bytes.NewReader(createTplBody(t, "co", teamB)))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

// TestPermissions_CreateTemplate_GlobalNonAdminDenied verifies non-admin users
// cannot create global templates (no owning_team_id).
func TestPermissions_CreateTemplate_GlobalNonAdminDenied(t *testing.T) {
	s := testStore(t)
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

	w := do(t, userR, http.MethodPost, "/v1/templates", bytes.NewReader(createTplBody(t, "cg", "")))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

// TestPermissions_PublishVersion_TeamEditorAllowed verifies a team editor
// can publish a draft version of a template owned by their team.
func TestPermissions_PublishVersion_TeamEditorAllowed(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "pub-" + suffix + "@example.com"
	subject := "stub-pe-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("Pub"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "editor")
	name := seedTemplateOwnedBy(t, adminR, tid)

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// TestPermissions_PublishVersion_ViewerDenied verifies a team viewer cannot
// publish a draft version of a template owned by their team.
func TestPermissions_PublishVersion_ViewerDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	suffix := randSuffix()
	email := "pubv-" + suffix + "@example.com"
	subject := "stub-pv-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("PubV"),
	})
	require.NoError(t, err)

	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, email, "viewer")
	name := seedTemplateOwnedBy(t, adminR, tid)

	userR := api.NewRouter(config.Config{},
		api.Deps{Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}}, Store: s})

	w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

// TestPermissions_TeamTemplate_ViewerDenied verifies that team viewers
// cannot mutate templates owned by their team (only editors and admins can).
func TestPermissions_TeamTemplate_ViewerDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	// Create a user and add them as a viewer to a team.
	suffix := randSuffix()
	userEmail := "bob-" + suffix + "@example.com"
	userSubject := "stub-viewer-" + suffix

	// Create the user in the database directly so they exist before adding to team
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: userSubject,
		Email:       store.PgText(userEmail),
		DisplayName: store.PgText("Bob"),
	})
	require.NoError(t, err)

	// Create a router with the user's credentials
	userVerifier := customVerifier{claims: auth.Claims{Subject: userSubject, Email: userEmail, Name: "Bob"}}
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: userVerifier, Store: s})

	// Create a team as admin and add bob as viewer
	tid := createTeam(t, adminR, "team-"+randSuffix())
	addMember(t, adminR, tid, userEmail, "viewer")

	// Create a team-owned template as admin
	name := seedTemplateOwnedBy(t, adminR, tid)
	publishV1(t, adminR, name)

	// Bob (viewer) attempts to deprecate the template.
	w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusForbidden, w.Code)
}
