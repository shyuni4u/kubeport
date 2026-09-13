package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// fakeDemoAPI answers Dex's token endpoint and the API's /v1/me and
// /v1/clusters the way a running install would.
func fakeDemoAPI(t *testing.T, clustersStatus int, clustersBody string) (dexURL, apiURL string) {
	t.Helper()
	dex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id_token":"fake.id.token"}`))
	}))
	t.Cleanup(dex.Close)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me":
			_, _ = w.Write([]byte(`{}`))
		case "/v1/clusters":
			w.WriteHeader(clustersStatus)
			_, _ = w.Write([]byte(clustersBody))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(api.Close)
	return dex.URL, api.URL
}

// #363: the chart's default demo.cluster is the live demo's. On an install that
// registered its cluster under another name, the seed's POST /v1/releases
// answered 404 only after the reset had emptied the demo. Preflight now names
// the problem while the demo is intact — the database, unreachable here, is
// never reached.
func TestRunPreflight_UnregisteredDemoClusterStopsBeforeTheDatabase(t *testing.T) {
	dex, api := fakeDemoAPI(t, http.StatusOK, `{"clusters":[{"name":"kind-dev"},{"name":"staging"}]}`)
	setDemoEnv(t, dex, "admin@demo.kubeport")
	t.Setenv("KBP_API_BASE_URL", api)

	pf, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.Error(t, err)
	require.Nil(t, pf, "no preflight means reset() is unreachable — the demo keeps its data")
	require.Contains(t, err.Error(), `DEMO_CLUSTER "oci-a1" is not a registered cluster (registered: kind-dev, staging)`)
	require.Contains(t, err.Error(), "demo.cluster")
	require.NotContains(t, err.Error(), "store:")
}

func TestRunPreflight_NoClusterRegisteredSaysSo(t *testing.T) {
	dex, api := fakeDemoAPI(t, http.StatusOK, `{"clusters":[]}`)
	setDemoEnv(t, dex, "admin@demo.kubeport")
	t.Setenv("KBP_API_BASE_URL", api)

	_, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.ErrorContains(t, err, "(registered: none)")
}

func TestRunPreflight_ClusterListFailureStopsBeforeTheDatabase(t *testing.T) {
	dex, api := fakeDemoAPI(t, http.StatusInternalServerError, `{"title":"internal"}`)
	setDemoEnv(t, dex, "admin@demo.kubeport")
	t.Setenv("KBP_API_BASE_URL", api)

	pf, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.Nil(t, pf)
	require.ErrorContains(t, err, "/v1/clusters: 500")
	require.NotContains(t, err.Error(), "store:")
}

// A registered cluster passes: preflight goes on to the database, which is
// where this test's unreachable DSN stops it.
func TestRunPreflight_RegisteredDemoClusterPasses(t *testing.T) {
	dex, api := fakeDemoAPI(t, http.StatusOK, `{"clusters":[{"name":"staging"},{"name":"kind-dev"}]}`)
	setDemoEnv(t, dex, "admin@demo.kubeport")
	t.Setenv("KBP_API_BASE_URL", api)
	t.Setenv("DEMO_CLUSTER", "kind-dev")

	_, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.ErrorContains(t, err, "store:", "the cluster check passed and preflight reached the database")
	require.NotContains(t, err.Error(), "DEMO_CLUSTER")
}
