package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// unreachableDSN points at a port nothing listens on. Any test that reaches
// store.NewStore with it fails slowly and loudly, which is the point: these
// tests assert preflight gives up *before* touching the database.
const unreachableDSN = "postgres://kubeport:kubeport@127.0.0.1:1/kubeport?sslmode=disable&connect_timeout=1"

func setDemoEnv(t *testing.T, issuer, adminEmail string) {
	t.Helper()
	t.Setenv("DEMO_OIDC_ISSUER", issuer)
	t.Setenv("DEMO_OIDC_CLIENT_ID", "kubeport-demo")
	t.Setenv("DEMO_OIDC_CLIENT_SECRET", "shh")
	t.Setenv("DEMO_ADMIN_EMAIL", adminEmail)
	t.Setenv("DEMO_ADMIN_PASSWORD", "pw")
	t.Setenv("DEMO_USER_EMAIL", "user@demo.kubeport")
	t.Setenv("DEMO_USER_PASSWORD", "pw")
	t.Setenv("KBP_API_BASE_URL", "http://127.0.0.1:1")
}

// #105: a misconfigured DEMO_ADMIN_EMAIL must be caught with no I/O at all.
// Both the issuer and the DSN below are unreachable — reaching either would
// mean the check moved after something that can hang or spend a token grant.
func TestRunPreflight_NonDemoAdminIsRejectedBeforeAnyIO(t *testing.T) {
	setDemoEnv(t, "http://127.0.0.1:1", "someone@example.com")

	pf, err := runPreflight(context.Background(), http.DefaultClient, unreachableDSN, "demo.kubeport")

	require.Error(t, err)
	require.Nil(t, pf, "no preflight means reset() is unreachable — the demo keeps its data")
	require.Contains(t, err.Error(), "outside KBP_DEMO_EMAIL_DOMAIN")
}

// #105 is the reason this file exists: resetDB used to run first, so a Dex
// outage emptied the demo and only then failed, leaving it empty for the next
// six hours. Preflight must surface the outage while the data is still there.
func TestRunPreflight_DexOutageDoesNotYieldAPreflight(t *testing.T) {
	dex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "dex is down", http.StatusServiceUnavailable)
	}))
	defer dex.Close()
	setDemoEnv(t, dex.URL, "admin@demo.kubeport")

	pf, err := runPreflight(context.Background(), dex.Client(), unreachableDSN, "demo.kubeport")

	require.Error(t, err)
	require.Nil(t, pf)
	require.Contains(t, err.Error(), "admin token")
	require.Contains(t, err.Error(), "503")
}

// A token that Dex issues but the API rejects is the other way the old order
// wiped first and failed second — the seeder would have had no way back in.
func TestRunPreflight_APIRejectingTheTokenDoesNotYieldAPreflight(t *testing.T) {
	dex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id_token":"fake.id.token"}`))
	}))
	defer dex.Close()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer api.Close()

	setDemoEnv(t, dex.URL, "admin@demo.kubeport")
	t.Setenv("KBP_API_BASE_URL", api.URL)

	pf, err := runPreflight(context.Background(), dex.Client(), unreachableDSN, "demo.kubeport")

	require.Error(t, err)
	require.Nil(t, pf)
	require.Contains(t, err.Error(), "/v1/me")
}
