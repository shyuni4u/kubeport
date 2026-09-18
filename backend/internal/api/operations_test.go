package api_test

import (
	"bytes"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"kubeport/internal/api"
	"kubeport/internal/config"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOperationsSettingsConcurrency(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	name := registerCluster(t, r)
	req := httptest.NewRequest("GET", "/v1/clusters/"+name+"/settings", nil)
	req.Header.Set("Authorization", "Bearer admin")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	var data map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &data))
	require.NotEmpty(t, data["api_url"])
	original := data["api_url"]
	delete(data, "api_url")
	data["display_name"] = "Updated"
	data["default_namespace"] = "team"
	body, e := json.Marshal(data)
	require.NoError(t, e)
	for _, status := range []int{200, 409} {
		req = httptest.NewRequest("PATCH", "/v1/clusters/"+name+"/settings", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer admin")
		req.Header.Set("Content-Type", "application/json")
		w = httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, status, w.Code, w.Body.String())
	}
	req = httptest.NewRequest("GET", "/v1/clusters/"+name+"/settings", nil)
	req.Header.Set("Authorization", "Bearer admin")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, 200, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &data))
	require.Equal(t, original, data["api_url"])
	require.Equal(t, "team", data["default_namespace"])
}

func TestOperationsDemoDeniedBeforeInfrastructureAccess(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: demoVerifier{email: "demo-admin@demo.kubeport"}, DemoEmailDomain: "demo.kubeport"})
	for _, tc := range []struct{ method, path string }{{"GET", "settings"}, {"PATCH", "settings"}, {"GET", "diagnostics"}, {"GET", "operations?area=nodes"}, {"POST", "operations"}} {
		req := httptest.NewRequest(tc.method, "/v1/clusters/prod/"+tc.path, strings.NewReader(`{"action":"cordon","name":"node-a"}`))
		req.Header.Set("Authorization", "Bearer demo")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, 403, w.Code)
		require.Contains(t, w.Body.String(), "demo-restricted")
	}
}

func TestOperationsUserCannotPerformAdminActions(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}})
	for _, action := range []string{"cordon", "uncordon", "evict", "publish-storage", "publish-ingress"} {
		req := httptest.NewRequest("POST", "/v1/clusters/prod/operations", strings.NewReader(`{"action":"`+action+`","name":"target"}`))
		req.Header.Set("Authorization", "Bearer user")
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, 403, w.Code)
	}
	for _, path := range []string{"settings", "operations?area=nodes"} {
		req := httptest.NewRequest("GET", "/v1/clusters/prod/"+path, nil)
		req.Header.Set("Authorization", "Bearer user")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, 403, w.Code)
	}
}
