package k8s_test

import (
	"context"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

func TestSecureClientNeverSendsTokenOverHTTP(t *testing.T) {
	called := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer s.Close()
	_, err := k8s.NewWithToken(s.URL, "present", "secret-token")
	require.ErrorContains(t, err, "HTTPS")
	require.False(t, called)
	for _, raw := range []string{"ftp://example.com", "https://user:pass@example.com", "https://example.com?token=x", "https://example.com#fragment", "example.com"} {
		require.Error(t, k8s.ValidateAPIURL(raw, false), raw)
	}
	require.NoError(t, k8s.ValidateAPIURL("https://example.com:6443", false))
	require.NoError(t, k8s.ValidateAPIURL(s.URL, true))
}

func TestSecureClientRefusesRedirectDowngrade(t *testing.T) {
	called := false
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer plain.Close()
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL, http.StatusFound)
	}))
	defer tls.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tls.Certificate().Raw})
	client, err := k8s.NewWithToken(tls.URL, string(ca), "secret-token")
	require.NoError(t, err)
	_, err = client.CheckAccess(context.Background(), k8s.AccessCheck{Resource: "pods", Verb: "list"})
	require.Error(t, err)
	require.False(t, called, "redirect destination must not receive a request")
}

func TestNewWithToken_RequiresCaBundle(t *testing.T) {
	_, err := k8s.NewWithToken("https://localhost:6443", "", "token")
	require.Error(t, err)
	require.Contains(t, err.Error(), "caBundle is required")
}

func TestNewWithToken_WithCaBundle(t *testing.T) {
	// Self-signed CA cert for testing only.
	const testCA = `-----BEGIN CERTIFICATE-----
MIIBczCCARmgAwIBAgIUW6er74QKLojaC1wYLhpevuxmAZMwCgYIKoZIzj0EAwIw
DzENMAsGA1UEAwwEdGVzdDAeFw0yNjA0MTgwNjQ1NThaFw0yNjA0MTkwNjQ1NTha
MA8xDTALBgNVBAMMBHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ72ygp
hrvDCrQE2XzMj9t2nkCgEiA9+Ikd2b08AZ/pJg3OCORpBZ0CzhnQhTti2i7c2N7d
zTH1747l+jRhHCjEo1MwUTAdBgNVHQ4EFgQUAZ/Z9hVBLTMzx7A1G/ZoaPyRJmcw
HwYDVR0jBBgwFoAUAZ/Z9hVBLTMzx7A1G/ZoaPyRJmcwDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNIADBFAiBhd1FomJUJBP/sIBYStgzif136RdjAPcxXcdB7
F9CdrgIhAKjSL1EsIT5z4XDuAN4x4j0EPHTMWtIJLE1v9NN7MBb1
-----END CERTIFICATE-----`
	cli, err := k8s.NewWithToken("https://localhost:6443", testCA, "token")
	require.NoError(t, err)
	require.NotNil(t, cli)
}

// TestApplyAll_IntegrationWithKind is opt-in: skipped unless KIND_API is set.
// Point KIND_API at a kind cluster's API URL and DEX_TOKEN at a bearer token
// allowed to create and patch ConfigMaps in the default namespace.
//
// KBP_REQUIRE_KIND turns the skip into a failure, for where a cluster is
// supposed to exist (playwright.yml). A test that skips itself is green
// whether or not the harness still works, which is how this one went years
// without running anywhere at all (#121).
func TestApplyAll_IntegrationWithKind(t *testing.T) {
	apiURL := os.Getenv("KIND_API")
	if apiURL == "" {
		if os.Getenv("KBP_REQUIRE_KIND") != "" {
			t.Fatal("KBP_REQUIRE_KIND is set but KIND_API is not — the kind harness did not wire up")
		}
		t.Skip("KIND_API not set; skipping kind integration test")
	}

	cli, err := k8s.NewInsecureWithToken(apiURL, os.Getenv("DEX_TOKEN"))
	require.NoError(t, err)

	suffix := time.Now().Format("150405.000000")
	name := "kubeport-t12-" + suffix
	yaml := []byte(fmt.Sprintf(`apiVersion: v1
kind: ConfigMap
metadata:
  name: %s
  namespace: default
data:
  hello: world
`, name))

	ctx := context.Background()
	require.NoError(t, cli.ApplyAll(ctx, "default", yaml), "first apply")
	require.NoError(t, cli.ApplyAll(ctx, "default", yaml), "second apply (SSA idempotency)")
}

// The test above deploys through NewInsecureWithToken, which skips certificate
// verification — so on its own it would leave the deploy path's verifying
// constructor with no cluster-backed coverage at all, which is the shape of
// bug #101 (an unusable ca_bundle silently disabling TLS on the deploy path
// only). This runs the same apply through NewWithToken and a real CA.
func TestApplyAll_VerifiesTLSWithKind(t *testing.T) {
	apiURL := os.Getenv("KIND_API")
	ca := os.Getenv("KIND_CA")
	if apiURL == "" || ca == "" {
		missing := "KIND_API"
		if apiURL != "" {
			missing = "KIND_CA"
		}
		if os.Getenv("KBP_REQUIRE_KIND") != "" {
			t.Fatalf("KBP_REQUIRE_KIND is set but %s is not — the kind harness did not wire up", missing)
		}
		t.Skip(missing + " not set; skipping kind integration test")
	}

	cli, err := k8s.NewWithToken(apiURL, ca, os.Getenv("DEX_TOKEN"))
	require.NoError(t, err)

	name := "kubeport-tls-" + time.Now().Format("150405.000000")
	yaml := []byte(fmt.Sprintf(`apiVersion: v1
kind: ConfigMap
metadata:
  name: %s
  namespace: default
data:
  hello: world
`, name))

	require.NoError(t, cli.ApplyAll(context.Background(), "default", yaml),
		"apply with a verified TLS connection")
}
