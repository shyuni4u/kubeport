package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

func TestPreview_ReturnsResourcesAndUISpec(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}})
	body := map[string]any{
		"ui_state": map[string]any{
			"resources": []any{
				map[string]any{
					"apiVersion": "apps/v1",
					"kind":       "Deployment",
					"name":       "web",
					"fields": map[string]any{
						"spec.replicas": map[string]any{
							"mode": "exposed",
							"uiSpec": map[string]any{
								"label": "Replicas", "type": "integer", "default": 2, "required": true,
							},
						},
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/templates/preview", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var got struct {
		ResourcesYAML string `json:"resources_yaml"`
		UISpecYAML    string `json:"ui_spec_yaml"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Contains(t, got.ResourcesYAML, "kind: Deployment")
	require.Contains(t, got.ResourcesYAML, "replicas: 2") // default applied
	require.Contains(t, got.UISpecYAML, "Deployment[web].spec.replicas")
}
