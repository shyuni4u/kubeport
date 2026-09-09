package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The deploy path forwards the caller's id_token to the target cluster, so an
// empty ca_bundle there means shipping a bearer token over a connection nobody
// verified. openapi_proxy.go (schema reads only) already refuses that unless
// KBP_DEV_ALLOW_INSECURE_CLUSTERS is set — the gate was on the read path and
// missing from the write path, which is backwards. See issue #96.
func TestK8sFactory_RefusesEmptyCABundleByDefault(t *testing.T) {
	t.Setenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS", "")
	_, err := k8sFactory{}.NewWithToken("https://apiserver.example:6443", "", "tok")
	require.Error(t, err)
	require.Contains(t, err.Error(), "ca_bundle")
	require.Contains(t, err.Error(), "KBP_DEV_ALLOW_INSECURE_CLUSTERS",
		"the error has to say how to opt in for local dev")
}

func TestK8sFactory_AllowsEmptyCABundleWhenOptedIn(t *testing.T) {
	t.Setenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS", "true")
	cli, err := k8sFactory{}.NewWithToken("https://apiserver.example:6443", "", "tok")
	require.NoError(t, err)
	require.NotNil(t, cli)
}

// A cluster that registered a CA is unaffected either way.
func TestK8sFactory_CABundlePathIgnoresTheEnv(t *testing.T) {
	t.Setenv("KBP_DEV_ALLOW_INSECURE_CLUSTERS", "")
	// Not a valid PEM, so this fails — but it must fail inside the verified
	// path, not fall back to the insecure one.
	_, err := k8sFactory{}.NewWithToken("https://apiserver.example:6443", "not-a-pem", "tok")
	require.Error(t, err)
	require.NotContains(t, err.Error(), "KBP_DEV_ALLOW_INSECURE_CLUSTERS")
}
