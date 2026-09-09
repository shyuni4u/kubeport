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

// registerCluster seeds one cluster so the list endpoint has something to
// return regardless of what other tests left behind.
func registerCluster(t *testing.T, r http.Handler) string {
	t.Helper()
	name := "disc-" + randSuffix()
	body := bytes.NewReader([]byte(`{"name":"` + name + `","api_url":"https://secret-apiserver.internal",` +
		`"ca_bundle":"-----BEGIN CERTIFICATE-----","oidc_issuer_url":"https://issuer.example",` +
		`"default_namespace":"default"}`))
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
	return name
}

func listClusters(t *testing.T, r http.Handler) []map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/clusters", nil)
	req.Header.Set("Authorization", "Bearer x")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var got struct {
		Clusters []map[string]any `json:"clusters"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.NotEmpty(t, got.Clusters, "expected at least the cluster this test registered")
	return got.Clusters
}

// A non-admin caller must not learn the apiserver address, the CA bundle, or
// the issuer URL of any registered cluster (#52). The deploy form only ever
// reads name/default_namespace, so narrowing the payload costs the UI nothing.
func TestListClusters_NonAdmin_OmitsConnectionDetails(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	registerCluster(t, admin)

	user := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
	for _, cl := range listClusters(t, user) {
		require.NotContains(t, cl, "api_url")
		require.NotContains(t, cl, "ca_bundle")
		require.NotContains(t, cl, "oidc_issuer_url")

		// The fields the UI actually needs must survive the narrowing.
		require.Contains(t, cl, "name")
		require.Contains(t, cl, "default_namespace")
	}
}

// An admin still needs the full record — that is how a cluster registration is
// verified after the fact.
func TestListClusters_Admin_KeepsConnectionDetails(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	registerCluster(t, admin)

	var sawFull bool
	for _, cl := range listClusters(t, admin) {
		require.Contains(t, cl, "api_url")
		require.Contains(t, cl, "oidc_issuer_url")
		sawFull = true
	}
	require.True(t, sawFull)
}
