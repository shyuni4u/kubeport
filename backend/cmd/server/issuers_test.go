package main

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/config"
)

func TestResolveIssuers_LegacyPair(t *testing.T) {
	got, err := resolveIssuers(config.Config{OIDCIssuer: "https://a", OIDCAudience: "kubeport"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "https://a", got[0].Issuer)
	require.Equal(t, "kubeport", got[0].ClientID)
}

func TestResolveIssuers_JSONWins(t *testing.T) {
	got, err := resolveIssuers(config.Config{
		OIDCIssuer: "https://ignored", OIDCAudience: "ignored",
		OIDCIssuersJSON: `[{"issuer":"https://g","client_id":"gid"},{"issuer":"https://dex","client_id":"kubeport-demo"}]`,
	})
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, "https://dex", got[1].Issuer)
}

func TestResolveIssuers_NothingSet(t *testing.T) {
	_, err := resolveIssuers(config.Config{})
	require.Error(t, err)
}
