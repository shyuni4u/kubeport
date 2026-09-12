package api

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// codex review of #196: a path may name its Secret by selector or, when the
// template has only one, by kind alone. Both are a Secret's content; a kind
// that only starts with "Secret" is not.
func TestIsSecretPath(t *testing.T) {
	for path, want := range map[string]bool{
		"Secret[app-secret].stringData.API_KEY": true,
		"Secret[0].data.TOKEN":                  true,
		"Secret.stringData.API_KEY":             true,
		`Secret["stringData"]`:                  true,
		"Secret_x.y":                            false, // kind Secret by the grammar, but not its content
		"Secret[x].metadata.annotations.note":   false, // not redacted in rendered_yaml either
		"secret[app].stringData.KEY":            false, // the grammar refuses a lowercase kind
		"SecretStore[vault].spec.provider":      false,
		"Deployment[web].spec.replicas":         false,
		"ConfigMap.data.Secret":                 false,
	} {
		require.Equal(t, want, isSecretPath(path), path)
	}
}

func TestRedactAndRestoreSecretValues_EverySpellingOfASecretPath(t *testing.T) {
	stored := json.RawMessage(`{"Secret.stringData.API_KEY":"sk-1","Secret[app].data.T":"dG9r","SecretStore[v].spec.x":"kept","Deployment[web].spec.replicas":2}`)

	var redacted map[string]any
	require.NoError(t, json.Unmarshal(redactSecretValues(stored), &redacted))
	require.Equal(t, "<redacted>", redacted["Secret.stringData.API_KEY"])
	require.Equal(t, "<redacted>", redacted["Secret[app].data.T"])
	require.Equal(t, "kept", redacted["SecretStore[v].spec.x"])
	require.EqualValues(t, 2, redacted["Deployment[web].spec.replicas"])

	sent, err := json.Marshal(redacted)
	require.NoError(t, err)
	var restored map[string]any
	back, kept := restoreRedactedSecrets(sent, stored)
	require.True(t, kept)
	require.NoError(t, json.Unmarshal(back, &restored))
	require.Equal(t, "sk-1", restored["Secret.stringData.API_KEY"])
	require.Equal(t, "dG9r", restored["Secret[app].data.T"])
}
