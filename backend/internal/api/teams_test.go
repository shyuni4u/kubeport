package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

func TestTeams_Create_RequiresAdmin(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
	req := httptest.NewRequest(http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"plat-`+randSuffix()+`","display_name":"Platform"}`)))
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestTeams_Create_AdminSucceeds(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	name := "plat-" + randSuffix()
	req := httptest.NewRequest(http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"`+name+`","display_name":"Platform"}`)))
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, name, got["name"])
	require.NotEmpty(t, got["id"])
}

func TestTeams_List_NonAdminSeesOnlyTheirTeams(t *testing.T) {
	s := testStore(t)

	// Seed one team as admin; alice is not added.
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	teamName := "visible-" + randSuffix()
	w := do(t, adminR, http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"`+teamName+`","display_name":"Vis"}`)))
	require.Equal(t, http.StatusCreated, w.Code)

	// Alice lists teams — empty (she's not a member of any).
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
	w = do(t, userR, http.MethodGet, "/v1/teams", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), teamName)
}

func TestTeams_Members_AdminAddsByEmail(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	// Create a unique email to avoid collisions with previous test runs
	suffix := randSuffix()
	userEmail := "alice-" + suffix + "@example.com"
	userSubject := "stub-" + suffix

	// Create the user in the database
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: userSubject,
		Email:       store.PgText(userEmail),
		DisplayName: store.PgText("Test User"),
	})
	require.NoError(t, err)

	// Create a router with the user's credentials
	verifier := customVerifier{claims: auth.Claims{Subject: userSubject, Email: userEmail}}
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: verifier, Store: s})

	// Create team and add alice as editor.
	teamName := "mem-" + suffix
	var w *httptest.ResponseRecorder
	w = do(t, adminR, http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"`+teamName+`"}`)))
	require.Equal(t, http.StatusCreated, w.Code)
	var tm map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &tm))
	tid := tm["id"].(string)

	w = do(t, adminR, http.MethodPost, "/v1/teams/"+tid+"/members",
		bytes.NewReader([]byte(`{"email":"`+userEmail+`","role":"editor"}`)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	// Alice now sees the team.
	w = do(t, userR, http.MethodGet, "/v1/teams", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), teamName)
}

func TestTeams_Members_RemoveReverts(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	// Create a unique email to avoid collisions with previous test runs
	suffix := randSuffix()
	userEmail := "alice-" + suffix + "@example.com"
	userSubject := "stub-" + suffix

	// Create the user in the database
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: userSubject,
		Email:       store.PgText(userEmail),
		DisplayName: store.PgText("Test User"),
	})
	require.NoError(t, err)

	verifier := customVerifier{claims: auth.Claims{Subject: userSubject, Email: userEmail}}
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: verifier, Store: s})

	teamName := "rem-" + suffix
	w := do(t, adminR, http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"`+teamName+`"}`)))
	require.Equal(t, http.StatusCreated, w.Code)
	var tm map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &tm)
	tid := tm["id"].(string)

	w = do(t, adminR, http.MethodPost, "/v1/teams/"+tid+"/members",
		bytes.NewReader([]byte(`{"email":"`+userEmail+`","role":"editor"}`)))
	require.Equal(t, http.StatusCreated, w.Code)

	w = do(t, adminR, http.MethodGet, "/v1/teams/"+tid+"/members", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var lr struct {
		Members []struct {
			UserID string `json:"user_id"`
			Email  string `json:"email"`
		} `json:"members"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &lr))
	require.Len(t, lr.Members, 1)
	uid := lr.Members[0].UserID

	w = do(t, adminR, http.MethodDelete, "/v1/teams/"+tid+"/members/"+uid, nil)
	require.Equal(t, http.StatusNoContent, w.Code)

	// Alice no longer sees it.
	w = do(t, userR, http.MethodGet, "/v1/teams", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), teamName)
}

// customVerifier returns customizable claims for testing
type customVerifier struct {
	claims auth.Claims
}

func (v customVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return v.claims, nil
}

func TestTeams_Members_ListRequiresMembershipOrAdmin(t *testing.T) {
	s := testStore(t)
	suffix := randSuffix()

	// Create alice with a unique email
	aliceEmail := "alice-" + suffix + "@example.com"
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: "alice-" + suffix,
		Email:       store.PgText(aliceEmail),
		DisplayName: store.PgText("Alice"),
	})
	require.NoError(t, err)

	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	aliceVerifier := customVerifier{claims: auth.Claims{Subject: "alice-" + suffix, Email: aliceEmail}}
	userR := api.NewRouter(config.Config{}, api.Deps{Verifier: aliceVerifier, Store: s})

	// Create team as admin; alice is NOT added
	teamName := "priv-" + suffix
	w := do(t, adminR, http.MethodPost, "/v1/teams",
		bytes.NewReader([]byte(`{"name":"`+teamName+`"}`)))
	require.Equal(t, http.StatusCreated, w.Code)
	var tm map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &tm)
	tid := tm["id"].(string)

	// Non-member alice → 403
	w = do(t, userR, http.MethodGet, "/v1/teams/"+tid+"/members", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())

	// Admin → 200
	w = do(t, adminR, http.MethodGet, "/v1/teams/"+tid+"/members", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// Add alice as viewer
	w = do(t, adminR, http.MethodPost, "/v1/teams/"+tid+"/members",
		bytes.NewReader([]byte(`{"email":"`+aliceEmail+`","role":"viewer"}`)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	// Now alice should be able to list
	w = do(t, userR, http.MethodGet, "/v1/teams/"+tid+"/members", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}
