package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// openapi_path_test.go covers the segment rule as a pure function. This one
// goes through the router, because the #11 payloads have to survive net/http's
// percent-decoding and gin's path handling before the handler ever sees them —
// "the function is safe but the route is not" is exactly the regression worth
// guarding.
//
// The gv check runs before the cluster lookup, so no store is needed: a
// rejected request never reaches the DB.
func TestGetOpenAPIGroupVersion_RejectsTraversalOverHTTP(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}})
	for _, raw := range []string{
		"/v1/clusters/kind/openapi/../../../api/v1/namespaces/kube-system/secrets",
		"/v1/clusters/kind/openapi/%2e%2e/%2e%2e/%2e%2e/api/v1/namespaces/kube-system/secrets",
		"/v1/clusters/kind/openapi/%2e%2e/%2e%2e/api/v1",
		"/v1/clusters/kind/openapi/apps/v1/extra",
		"/v1/clusters/kind/openapi/APPS/v1",
	} {
		t.Run(raw, func(t *testing.T) {
			w := do(t, r, http.MethodGet, raw, nil)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), "validation-error")
		})
	}
}

// The values the frontend actually sends (frontend/lib/openapi.ts parseIndex
// yields "v1" and "<group>/<version>") must get past validation. With no store
// wired they fail at the cluster lookup with 404 — which is proof enough that
// the gv itself was accepted.
func TestGetOpenAPIGroupVersion_AcceptsRealGroupVersions(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	for _, gv := range []string{"v1", "apps/v1", "networking.k8s.io/v1"} {
		t.Run(gv, func(t *testing.T) {
			w := do(t, r, http.MethodGet, "/v1/clusters/no-such-cluster/openapi/"+gv, nil)
			require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), "not-found")
		})
	}
}
