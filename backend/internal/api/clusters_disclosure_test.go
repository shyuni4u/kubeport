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
)

// demoAdminVerifier is the public "관리자 체험" account: in the kubeport-admin
// group (the chart appends demo.adminEmail to KBP_DEV_ADMIN_EMAILS) but on the
// demo email domain, and its password is printed on the landing page.
type demoAdminVerifier struct{}

func (demoAdminVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return auth.Claims{
		Subject: "demo-admin",
		Email:   "demo-admin@demo.kubeport",
		Groups:  []string{"kubeport-admin"},
	}, nil
}

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

func requireNoConnectionDetails(t *testing.T, rows []map[string]any) {
	t.Helper()
	for _, cl := range rows {
		require.NotContains(t, cl, "api_url")
		require.NotContains(t, cl, "ca_bundle")
		require.NotContains(t, cl, "oidc_issuer_url")

		// The fields the UI and a programmatic client actually need must
		// survive the narrowing: the deploy form renders `name`, and both
		// POST /v1/releases and the SSAR address a cluster by name.
		require.Contains(t, cl, "name")
		require.Contains(t, cl, "default_namespace")
	}
}

// GET /v1/clusters must never hand out how to reach an apiserver (#52).
func TestListClusters_NonAdmin_OmitsConnectionDetails(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	registerCluster(t, admin)

	user := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
	requireNoConnectionDetails(t, listClusters(t, user))
}

// The response is deliberately not role-dependent. Gating on isKubeportAdmin
// would have left the hole wide open for the one caller #52 was about: the
// public demo admin is in the kubeport-admin group, so it would have received
// the production cluster's endpoint and CA.
func TestListClusters_DemoAdmin_OmitsConnectionDetails(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	registerCluster(t, admin)

	demo := api.NewRouter(config.Config{}, api.Deps{
		Verifier:        demoAdminVerifier{},
		Store:           s,
		DemoEmailDomain: "demo.kubeport",
	})
	requireNoConnectionDetails(t, listClusters(t, demo))
}

func TestListClusters_RealAdmin_AlsoOmitsConnectionDetails(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	registerCluster(t, admin)

	requireNoConnectionDetails(t, listClusters(t, admin))
}

// An admin registering a cluster still gets the full record back, which is how
// a registration is checked. Only the list is narrowed.
func TestCreateCluster_StillReturnsFullRecord(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	name := "disc-full-" + randSuffix()
	body := bytes.NewReader([]byte(`{"name":"` + name + `","api_url":"https://apiserver.internal",` +
		`"oidc_issuer_url":"https://issuer.example"}`))
	req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
	req.Header.Set("Authorization", "Bearer x")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	admin.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, "https://apiserver.internal", got["api_url"])
}
