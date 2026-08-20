package k8s_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

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
// with permission to create ConfigMaps in the default namespace.
func TestApplyAll_IntegrationWithKind(t *testing.T) {
	apiURL := os.Getenv("KIND_API")
	if apiURL == "" {
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
