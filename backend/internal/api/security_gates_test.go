package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

// POST /v1/clusters/:name/openapi/refresh drops the cached schema, so the next
// read re-fetches it from the target apiserver (up to 10MiB). It shipped with
// no role gate at all, while every other management route on the same file
// carries requireAdmin() + noDemo — so a demo visitor, whose password is on the
// landing page, could loop it against the production control plane. Issue #97.
func TestOpenAPIRefresh_RequiresAdmin(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "plain-" + randSuffix(), Email: "plain@example.com",
		}},
		Store: testStore(t),
	})
	w := do(t, r, http.MethodPost, "/v1/clusters/oci-a1/openapi/refresh", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

func TestOpenAPIRefresh_RefusedForDemoAccounts(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		// demoVerifier carries kubeport-admin, so only the demo gate can stop it.
		Verifier:        demoVerifier{email: "demo-admin@" + demoDomain},
		Store:           testStore(t),
		DemoEmailDomain: demoDomain,
	})
	w := do(t, r, http.MethodPost, "/v1/clusters/oci-a1/openapi/refresh", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "demo-restricted")
}

// A real admin still gets through: an unknown cluster name is fine here
// because RefreshOpenAPI only evicts cache entries, so it answers 204.
func TestOpenAPIRefresh_AllowedForRealAdmin(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	w := do(t, r, http.MethodPost, "/v1/clusters/oci-a1/openapi/refresh", nil)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
}
