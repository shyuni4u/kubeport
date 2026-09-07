package auth_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

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
