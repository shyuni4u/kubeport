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

func TestTemplates_CreateListPublish(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := "web-" + randSuffix()
	body := map[string]any{
		"name":           name,
		"display_name":   "Web Service",
		"description":    "simple",
		"tags":           []string{"web"},
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	require.Equal(t, http.StatusCreated, w.Code, "create body=%s", w.Body.String())

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	require.NotNil(t, created["template"])
	require.NotNil(t, created["version"])

	// list versions — should have 1 draft
	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"status":"draft"`)

	// get template by name — before publish: current_version is null,
	// owning_team_name is null (global template), but fields are present.
	w = do(t, r, http.MethodGet, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), name)
	require.Contains(t, w.Body.String(), `"current_version":`)
	require.Contains(t, w.Body.String(), `"owning_team_name":`)

	// get specific version
	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"status":"draft"`)

	// publish v1
	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, "publish body=%s", w.Body.String())
	require.Contains(t, w.Body.String(), `"status":"published"`)

	// after publish: current_version should be 1 (integer)
	w = do(t, r, http.MethodGet, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"current_version":1`)

	// republish should 409 (not in draft state)
	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusConflict, w.Code)
}

func TestTemplates_Create_InvalidYAMLReturns400(t *testing.T) {
	r := newTestRouterAdmin(t)
	body := map[string]any{
		"name":           "bad-" + randSuffix(),
		"display_name":   "Bad",
		"authoring_mode": "yaml",
		"resources_yaml": "not: yaml: [",
		"ui_spec_yaml":   minimalUISpec,
	}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "validation-error")
}

func TestTemplates_Get_UnknownReturns404(t *testing.T) {
	r := newTestRouterAdmin(t)
	w := do(t, r, http.MethodGet, "/v1/templates/does-not-exist-"+randSuffix(), nil)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestTemplates_Create_UIMode(t *testing.T) {
	r := newTestRouterAdmin(t)
	body := map[string]any{
		"name":           "web-" + randSuffix(),
		"display_name":   "Web",
		"authoring_mode": "ui",
		"ui_state": map[string]any{
			"resources": []any{
				map[string]any{
					"apiVersion": "apps/v1", "kind": "Deployment", "name": "web",
					"fields": map[string]any{
						"spec.replicas": map[string]any{
							"mode":   "exposed",
							"uiSpec": map[string]any{"label": "Replicas", "type": "integer", "default": 1, "required": true},
						},
						"spec.selector.matchLabels.app":          map[string]any{"mode": "fixed", "fixedValue": "web"},
						"spec.template.metadata.labels.app":      map[string]any{"mode": "fixed", "fixedValue": "web"},
						"spec.template.spec.containers[0].name":  map[string]any{"mode": "fixed", "fixedValue": "app"},
						"spec.template.spec.containers[0].image": map[string]any{"mode": "fixed", "fixedValue": "nginx:1.25"},
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"authoring_mode":"ui"`)
	require.Contains(t, w.Body.String(), "kind: Deployment") // resources_yaml populated
}

func TestTemplates_Create_ModeMismatch_Rejected(t *testing.T) {
	r := newTestRouterAdmin(t)
	// mode=ui but no ui_state
	body := `{"name":"x-` + randSuffix() + `","display_name":"X","authoring_mode":"ui","resources_yaml":"","ui_spec_yaml":""}`
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "ui_state")

	// mode=yaml but ui_state present
	body = `{"name":"y-` + randSuffix() + `","display_name":"Y","authoring_mode":"yaml","resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n","ui_spec_yaml":"fields: []\n","ui_state":{"resources":[]}}`
	w = do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "ui_state")
}

func TestTemplates_Create_OwningTeam(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	tid := createTeam(t, adminR, "team-"+randSuffix())

	body := `{"name":"t-` + randSuffix() + `","display_name":"T","authoring_mode":"yaml",
      "resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n",
      "ui_spec_yaml":"fields: []\n","owning_team_id":"` + tid + `"}`
	w := do(t, adminR, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"owning_team_id"`)
}

func TestTemplates_Deprecate_RoundTrip(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)
	publishV1(t, r, name)

	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"status":"deprecated"`)

	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/undeprecate", nil)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"status":"published"`)
}

func TestTemplates_Deprecate_OnlyFromPublished(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)
	// Don't publish — deprecating a draft must 409.
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusConflict, w.Code)
}

func TestTemplates_NewVersion_UIMode(t *testing.T) {
	r := newTestRouterAdmin(t)

	// Seed v1 UI-mode template
	body := map[string]any{
		"name": "nv-" + randSuffix(), "display_name": "NV",
		"authoring_mode": "ui",
		"ui_state": map[string]any{
			"resources": []any{
				map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "name": "c", "fields": map[string]any{
					"data.k": map[string]any{"mode": "fixed", "fixedValue": "v1"},
				}},
			},
		},
	}
	raw, _ := json.Marshal(body)
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
	require.Equal(t, http.StatusCreated, w.Code)
	var created struct {
		Template struct{ Name string } `json:"template"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	name := created.Template.Name

	// publish v1 so we can create v2
	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
	require.Equal(t, http.StatusOK, w.Code, "publish v1: %s", w.Body.String())

	// Create v2 draft with new UI state
	nvBody := map[string]any{
		"authoring_mode": "ui",
		"ui_state": map[string]any{
			"resources": []any{
				map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "name": "c", "fields": map[string]any{
					"data.k": map[string]any{"mode": "fixed", "fixedValue": "v2"},
				}},
			},
		},
	}
	nvRaw, _ := json.Marshal(nvBody)
	w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions", bytes.NewReader(nvRaw))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"version":2`)
	require.Contains(t, w.Body.String(), `"status":"draft"`)
}

func TestTemplates_NewVersion_RejectsWhenDraftExists(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r) // leaves a draft v1

	nvBody := `{"authoring_mode":"yaml","resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n","ui_spec_yaml":"fields: []\n"}`
	w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions", bytes.NewReader([]byte(nvBody)))
	require.Equal(t, http.StatusConflict, w.Code)
}
