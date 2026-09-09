package api

import (
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The wildcard route `/v1/clusters/:name/openapi/*gv` used to concatenate the
// caller-supplied `gv` straight into the upstream path. `url.URL.JoinPath`
// runs `path.Join`, which collapses `..`, so `%2e%2e` segments escaped the
// intended `/openapi/v3` prefix and turned the endpoint into a general-purpose
// GET proxy for the k8s API — with the caller's OIDC token attached.
// See issue #11.
func TestOpenAPIUpstreamSegments_RejectsTraversal(t *testing.T) {
	// The exact strings gin hands to the handler for the PoC requests in #11,
	// after the leading slash is trimmed.
	bad := []string{
		"../../../api/v1/namespaces/kube-system/secrets",
		"../../api/v1",
		"..",
		"../apps/v1",
		"apps/../../api/v1",
		"apps/v1/..",
		"/apps/v1",
		"apps//v1",
		"apps/v1/extra",
		`apps\v1`,
		"apps/v1?watch=true",
		"APPS/v1",
		".",
		"./v1",
	}
	for _, gv := range bad {
		t.Run(gv, func(t *testing.T) {
			_, err := openapiUpstreamSegments(gv)
			require.Error(t, err, "expected %q to be rejected", gv)
		})
	}
}

func TestOpenAPIUpstreamSegments_AcceptsGroupVersions(t *testing.T) {
	cases := []struct {
		gv   string
		want []string
	}{
		{"", nil},
		{"v1", []string{"api", "v1"}},
		{"apps/v1", []string{"apis", "apps", "v1"}},
		{"batch/v1beta1", []string{"apis", "batch", "v1beta1"}},
		{"networking.k8s.io/v1", []string{"apis", "networking.k8s.io", "v1"}},
		// Admin-registered CRDs (v1.1 scope) may use any DNS-1035 version label.
		{"acme.example.com/v1alpha1", []string{"apis", "acme.example.com", "v1alpha1"}},
	}
	for _, tc := range cases {
		t.Run(tc.gv, func(t *testing.T) {
			got, err := openapiUpstreamSegments(tc.gv)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

// Even for accepted input the assembled URL must stay under the cluster's
// /openapi/v3 root, including when the cluster URL carries a base prefix
// (a reverse proxy routing /k8s-cluster-1/… to the apiserver).
func TestOpenAPIUpstreamSegments_StayUnderOpenAPIV3(t *testing.T) {
	for _, base := range []string{"https://apiserver.example:6443", "https://proxy.example/k8s-cluster-1"} {
		u, err := url.Parse(base)
		require.NoError(t, err)
		root := u.JoinPath("openapi", "v3")

		for _, gv := range []string{"", "v1", "apps/v1", "networking.k8s.io/v1"} {
			segs, err := openapiUpstreamSegments(gv)
			require.NoError(t, err)
			target := root.JoinPath(segs...)
			require.True(t, strings.HasPrefix(target.EscapedPath(), root.EscapedPath()),
				"base=%s gv=%q escaped the openapi root: %s", base, gv, target.EscapedPath())
		}
	}
}
