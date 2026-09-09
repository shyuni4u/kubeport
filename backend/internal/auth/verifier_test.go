package auth_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
)

// dexIssuer reads the OIDC_ISSUER env var, defaulting to the old plain-http
// local dex URL. Set to https://host.docker.internal:5556 (and OIDC_CA_FILE
// to the self-signed cert) when testing against the HTTPS dex setup used by
// docs/local-e2e.md.
func dexIssuer() string {
	if v := os.Getenv("OIDC_ISSUER"); v != "" {
		return v
	}
	return "http://localhost:5556"
}

func dexHTTPClient(t *testing.T) *http.Client {
	t.Helper()
	path := os.Getenv("OIDC_CA_FILE")
	if path == "" {
		return http.DefaultClient
	}
	pem, err := os.ReadFile(path)
	require.NoError(t, err)
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	require.True(t, pool.AppendCertsFromPEM(pem), "OIDC_CA_FILE: no certs parsed")
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
}

// requireDex returns an HTTP client for the local dex, skipping the test when
// dex isn't running. A fresh clone has no `deploy/docker/certs`, so dex won't
// even start (see docs/local-e2e.md §2) and these tests used to fail on every
// new machine — which taught people that a red `go test ./...` is normal.
//
// CI has dex, so it sets KBP_REQUIRE_DEX=1: there, an unreachable dex is a
// failure, not a skip. That flag outranks SKIP_OIDC — otherwise a stray
// SKIP_OIDC left in a workflow or repo variable would silently delete the dex
// coverage from a green run, which is the failure mode the guard exists to
// prevent.
func requireDex(t *testing.T) *http.Client {
	t.Helper()
	required := os.Getenv("KBP_REQUIRE_DEX") == "1"
	if os.Getenv("SKIP_OIDC") != "" {
		if required {
			t.Fatal("SKIP_OIDC and KBP_REQUIRE_DEX=1 are mutually exclusive; drop one")
		}
		t.Skip("SKIP_OIDC set")
	}
	client := dexHTTPClient(t)
	resp, err := client.Get(dexIssuer() + "/.well-known/openid-configuration")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return client
		}
		err = fmt.Errorf("discovery returned %s", resp.Status)
	}
	if required {
		t.Fatalf("dex at %s is required in this environment but unreachable: %v", dexIssuer(), err)
	}
	t.Skipf("dex at %s not reachable (%v) — generate deploy/docker/certs and run "+
		"`docker compose -f deploy/docker/docker-compose.yml up -d` (docs/local-e2e.md §2). "+
		"Set KBP_REQUIRE_DEX=1 to fail instead of skipping.", dexIssuer(), err)
	return nil
}

// getDexToken fetches an id_token from the local dex using the password grant.
// Requires `docker compose -f deploy/docker/docker-compose.yml up -d` with
// enablePasswordDB: true so alice@example.com can authenticate.
func getDexToken(t *testing.T, client *http.Client) string {
	t.Helper()
	form := url.Values{}
	form.Set("grant_type", "password")
	form.Set("client_id", "kubeport")
	form.Set("client_secret", "local-dev-secret")
	form.Set("username", "alice@example.com")
	form.Set("password", "alice")
	form.Set("scope", "openid email profile")

	resp, err := client.PostForm(dexIssuer()+"/token", form)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, "dex returned non-200 from /token")

	var body struct {
		IDToken string `json:"id_token"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.NotEmpty(t, body.IDToken, "dex /token response had no id_token")
	return body.IDToken
}

func TestHTTPClientFromCAFile_MissingFile(t *testing.T) {
	_, err := auth.HTTPClientFromCAFile("/nonexistent/path/to/ca.crt")
	require.Error(t, err)
	require.Contains(t, err.Error(), "read OIDC_CA_FILE")
}

func TestHTTPClientFromCAFile_MalformedPEM(t *testing.T) {
	path := t.TempDir() + "/bad.crt"
	require.NoError(t, os.WriteFile(path, []byte("not a pem\n"), 0o644))
	_, err := auth.HTTPClientFromCAFile(path)
	require.Error(t, err)
	require.Contains(t, err.Error(), "no certs parsed")
}

func TestHTTPClientFromCAFile_ValidPEMReturnsClient(t *testing.T) {
	caPath := os.Getenv("OIDC_CA_FILE")
	if caPath == "" {
		t.Skip("OIDC_CA_FILE not set; requires deploy/docker/certs/dex.crt or equivalent")
	}
	c, err := auth.HTTPClientFromCAFile(caPath)
	require.NoError(t, err)
	require.NotNil(t, c)
	require.NotNil(t, c.Transport)
}

func TestVerifier_Verify(t *testing.T) {
	client := requireDex(t)
	ctx := context.Background()
	v, err := auth.NewVerifier(ctx, dexIssuer(), "kubeport")
	require.NoError(t, err)

	token := getDexToken(t, client)
	require.False(t, strings.HasPrefix(token, "<"))

	claims, err := v.Verify(ctx, token)
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", claims.Email)
}
