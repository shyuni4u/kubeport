package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

const minimalResources = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: placeholder
`

const minimalUISpec = `
fields:
  - path: Deployment[web].spec.replicas
    label: "Replicas"
    type: integer
    min: 1
    max: 20
    default: 1
`

func newTestRouterAdmin(t *testing.T) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
}

func do(t *testing.T, r http.Handler, method, path string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Authorization", "Bearer x")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// seedGlobalTemplate creates a minimal yaml-mode template with no owning team
// and returns its name.
func seedGlobalTemplate(t *testing.T, router http.Handler) string {
	t.Helper()
	name := "global-" + randSuffix()
	body := map[string]any{
		"name":           name,
		"display_name":   "Global Template",
		"description":    "test global template",
		"tags":           []string{"global"},
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	}
	raw, _ := json.Marshal(body)
	w := do(t, router, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	if w.Code != http.StatusCreated {
		t.Fatalf("seedGlobalTemplate POST /v1/templates failed: %d %s", w.Code, w.Body.String())
	}
	return name
}

// seedTemplateOwnedBy creates a template owned by the given team and returns its name.
//
// NOTE: Task 10 (POST /v1/templates owning_team_id support) is not yet implemented.
// This helper sends owning_team_id in the request body, but the API may ignore it.
// Until Task 10 is done, the template will be created as a global template (owning_team_id NULL).
// This is expected and documented here. The test will fail with "team editor required" or similar
// until Task 10 wires the endpoint to accept and persist owning_team_id.
func seedTemplateOwnedBy(t *testing.T, router http.Handler, teamID string) string {
	t.Helper()
	name := "team-owned-" + randSuffix()
	body := map[string]any{
		"name":           name,
		"display_name":   "Team Template",
		"description":    "test team-owned template",
		"tags":           []string{"team"},
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
		"owning_team_id": teamID,
	}
	raw, _ := json.Marshal(body)
	w := do(t, router, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	if w.Code != http.StatusCreated {
		t.Fatalf("seedTemplateOwnedBy POST /v1/templates failed: %d %s", w.Code, w.Body.String())
	}
	return name
}

// createTeam creates a team with the given name and returns its ID.
func createTeam(t *testing.T, router http.Handler, name string) string {
	t.Helper()
	body := map[string]any{
		"name": name,
	}
	raw, _ := json.Marshal(body)
	w := do(t, router, http.MethodPost, "/v1/teams", bytes.NewReader(raw))
	if w.Code != http.StatusCreated {
		t.Fatalf("createTeam POST /v1/teams failed: %d %s", w.Code, w.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("createTeam unmarshal response: %v", err)
	}
	tid, ok := result["id"].(string)
	if !ok {
		t.Fatalf("createTeam response missing or non-string id: %v", result)
	}
	return tid
}

// addMember adds a team member with the given email and role.
func addMember(t *testing.T, router http.Handler, teamID, email, role string) {
	t.Helper()
	body := map[string]any{
		"email": email,
		"role":  role,
	}
	raw, _ := json.Marshal(body)
	w := do(t, router, http.MethodPost, "/v1/teams/"+teamID+"/members", bytes.NewReader(raw))
	if w.Code != http.StatusCreated {
		t.Fatalf("addMember POST /v1/teams/%s/members failed: %d %s", teamID, w.Code, w.Body.String())
	}
}

// publishV1 publishes version 1 of the template with the given name.
func publishV1(t *testing.T, router http.Handler, name string) {
	t.Helper()
	w := do(t, router, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("publishV1 POST /v1/templates/%s/versions/1/publish failed: %d %s", name, w.Code, w.Body.String())
	}
}
