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

func TestTemplateValidationRejectsBadDraftBeforeClusterAccess(t *testing.T) {
	router := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}})
	for _, spec := range []string{
		"fields:\n- path: Deployment[missing].spec.replicas\n  type: integer\n  label: Replicas\n",
		"fields:\n- path: Deployment[app].spec.replicas\n  type: integer\n  label: Replicas\n  required: true\n",
	} {
		body, err := json.Marshal(map[string]any{"resources_yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n", "ui_spec_yaml": spec, "values": map[string]any{}, "cluster": "test", "namespace": "default", "name": "test"})
		require.NoError(t, err)
		response := do(t, router, http.MethodPost, "/v1/templates/validate", bytes.NewReader(body))
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), "validation-error")
	}
}

func TestTemplateValidationRejectsDemoBeforeClusterAccess(t *testing.T) {
	router := api.NewRouter(config.Config{}, api.Deps{Verifier: demoVerifier{email: "admin@demo.kubeport"}, DemoEmailDomain: "demo.kubeport"})
	response := do(t, router, http.MethodPost, "/v1/templates/validate", bytes.NewReader([]byte(`{}`)))
	require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "demo-restricted")
}
