package auth_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/auth"
)

func fakeJWT(t *testing.T, payload map[string]any) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	b, err := json.Marshal(payload)
	require.NoError(t, err)
	return hdr + "." + base64.RawURLEncoding.EncodeToString(b) + ".sig"
}

func TestPeekIssuer(t *testing.T) {
	tok := fakeJWT(t, map[string]any{"iss": "https://dex.example", "sub": "x"})
	iss, err := auth.PeekIssuer(tok)
	require.NoError(t, err)
	require.Equal(t, "https://dex.example", iss)

	_, err = auth.PeekIssuer("not.a.jwt.at.all")
	require.Error(t, err)
	_, err = auth.PeekIssuer("garbage")
	require.Error(t, err)
}

func TestParseIssuersJSON(t *testing.T) {
	cfgs, err := auth.ParseIssuersJSON(`[{"issuer":"https://a","client_id":"ca"},{"issuer":"https://b","client_id":"cb"}]`)
	require.NoError(t, err)
	require.Len(t, cfgs, 2)
	require.Equal(t, "cb", cfgs[1].ClientID)

	_, err = auth.ParseIssuersJSON(`[]`)
	require.Error(t, err, "empty list must be rejected")
	_, err = auth.ParseIssuersJSON(`[{"issuer":"","client_id":"x"}]`)
	require.Error(t, err, "blank issuer must be rejected")
	_, err = auth.ParseIssuersJSON(`[{"issuer":"https://a","client_id":"x"},{"issuer":"https://a","client_id":"y"}]`)
	require.Error(t, err, "duplicate issuer must be rejected")
}

func TestMultiVerifier_UnknownIssuerRejected(t *testing.T) {
	if os.Getenv("SKIP_OIDC") != "" {
		t.Skip("SKIP_OIDC set")
	}
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{{Issuer: dexIssuer(), ClientID: "kubeport"}})
	require.NoError(t, err)
	require.Equal(t, []string{dexIssuer()}, m.Issuers())

	tok := fakeJWT(t, map[string]any{"iss": "https://evil.example", "sub": "x"})
	_, err = m.Verify(ctx, tok)
	require.Error(t, err)
	require.Contains(t, err.Error(), "unknown issuer")
}

// Discovery is lazy: an unreachable issuer must not fail construction, but
// verifying a token minted by it must surface the discovery error (-> 401),
// and the failure must not be cached.
func TestMultiVerifier_UnreachableIssuerIsLazy(t *testing.T) {
	ctx := context.Background()
	const dead = "https://127.0.0.1:1/dead-issuer"
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{{Issuer: dead, ClientID: "kubeport"}})
	require.NoError(t, err, "unreachable issuer must not be fatal at construction")
	require.Equal(t, []string{dead}, m.Issuers())

	tok := fakeJWT(t, map[string]any{"iss": dead, "sub": "x"})
	_, err = m.Verify(ctx, tok)
	require.Error(t, err, "verify against an undiscoverable issuer must fail")
	_, err = m.Verify(ctx, tok)
	require.Error(t, err, "retry must still fail, not panic on a cached nil")
}

func TestMultiVerifier_RoutesToDex(t *testing.T) {
	if os.Getenv("SKIP_OIDC") != "" {
		t.Skip("SKIP_OIDC set")
	}
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{
		{Issuer: dexIssuer(), ClientID: "kubeport"},
	})
	require.NoError(t, err)
	token := getDexToken(t, dexHTTPClient(t))
	claims, err := m.Verify(ctx, token)
	require.NoError(t, err)
	require.Equal(t, "alice@example.com", claims.Email)
}

// badIssuer is a non-routable/closed port: nothing listens on 127.0.0.1:9
// ("discard" port), so a connection attempt fails fast (connection refused)
// rather than hanging for the full discoveryTimeout — keeping these tests
// quick while still exercising the failure path.
const badIssuer = "https://127.0.0.1:9/dead-issuer"

// TestMultiVerifier_DiscoveryTimeoutAndNegativeCache is the B2 regression
// test: one issuer's discovery must be bounded (not hang forever) and a
// second Verify against the same still-unreachable issuer must hit the
// negative cache instead of dialing again.
func TestMultiVerifier_DiscoveryTimeoutAndNegativeCache(t *testing.T) {
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{{Issuer: badIssuer, ClientID: "kubeport"}})
	require.NoError(t, err, "unreachable issuer must not be fatal at construction")
	require.Equal(t, []string{badIssuer}, m.Issuers())

	tok := fakeJWT(t, map[string]any{"iss": badIssuer, "sub": "x"})

	start := time.Now()
	_, err = m.Verify(ctx, tok)
	firstElapsed := time.Since(start)
	require.Error(t, err, "verify against an undiscoverable issuer must fail")
	require.Less(t, firstElapsed, 7*time.Second, "discovery must be bounded by discoveryTimeout, not hang")

	start = time.Now()
	_, err = m.Verify(ctx, tok)
	secondElapsed := time.Since(start)
	require.Error(t, err, "still-unreachable issuer must keep failing")
	require.Less(t, secondElapsed, time.Second, "second attempt within the negative-cache window must fail fast, without redialing")
}

// TestMultiVerifier_PerIssuerLockIsolation covers the actual B2 bug: a
// blocked/slow issuer's discovery must not serialize behind a single mutex
// and prevent verification of tokens from a different, healthy issuer.
func TestMultiVerifier_PerIssuerLockIsolation(t *testing.T) {
	if os.Getenv("SKIP_OIDC") != "" {
		t.Skip("SKIP_OIDC set")
	}
	ctx := context.Background()
	m, err := auth.NewMultiVerifier(ctx, []auth.IssuerConfig{
		{Issuer: badIssuer, ClientID: "kubeport"},
		{Issuer: dexIssuer(), ClientID: "kubeport"},
	})
	require.NoError(t, err)

	token := getDexToken(t, dexHTTPClient(t))
	claims, err := m.Verify(ctx, token)
	require.NoError(t, err, "a healthy issuer must verify fine even though another configured issuer is unreachable")
	require.Equal(t, "alice@example.com", claims.Email)
}
