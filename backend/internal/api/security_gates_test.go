package api_test

import (
	"bytes"
	"encoding/json"
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

// Every SSAR turns into a real call to the target apiserver, so the proxy only
// asks about the verbs and resources kubeport itself uses. Refusing here costs
// the control plane nothing — the alternative forwards the question. Issue #73.
func TestSSAR_RejectsVerbsKubeportNeverUses(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	for _, verb := range []string{"impersonate", "escalate", "bind", "*", "proxy"} {
		t.Run(verb, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"cluster": "any", "verb": verb, "group": "apps", "resource": "deployments",
			})
			w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), "validation-error")
		})
	}
}

func TestSSAR_RejectsResourcesKubeportDoesNotManage(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	for _, tc := range []struct{ group, resource string }{
		{"", "secrets/finalize"},
		{"rbac.authorization.k8s.io", "clusterrolebindings"},
		{"", "nodes"},
		{"", "pods"},
		// Right resource, wrong group — deployments live in apps, not core.
		{"", "deployments"},
	} {
		t.Run(tc.group+"/"+tc.resource, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"cluster": "any", "verb": "create", "group": tc.group, "resource": tc.resource,
			})
			w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
		})
	}
}

// Release deletion goes through DeleteCollection, which the k8s authorizer
// checks under its own verb. Refusing to ask about it would make preflight
// answer a question nobody asks: allowed on `delete`, refused on the real
// delete.
func TestSSAR_AcceptsDeleteCollection(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	body, _ := json.Marshal(map[string]any{
		"cluster":  "no-such-cluster-" + randSuffix(),
		"verb":     "deletecollection",
		"group":    "apps",
		"resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

// A rejected request has to name the allowed set — a client that can only
// learn the rule by trial and error keeps making the calls the limit exists to
// prevent.
func TestSSAR_RejectionNamesTheAllowedSets(t *testing.T) {
	r, _, _ := newSSARRouter(t)

	body, _ := json.Marshal(map[string]any{
		"cluster": "any", "verb": "escalate", "group": "apps", "resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.Contains(t, w.Body.String(), "create")
	require.Contains(t, w.Body.String(), "deletecollection")

	body, _ = json.Marshal(map[string]any{
		"cluster": "any", "verb": "create", "group": "", "resource": "nodes",
	})
	w = do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.Contains(t, w.Body.String(), "apps/deployments")
	require.Contains(t, w.Body.String(), "configmaps")
}

// A 429 must say how long to wait; without it a program either retries at once
// or sleeps an arbitrary constant.
func TestSSAR_RateLimitedCarriesRetryAfter(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	body := func() *bytes.Reader {
		b, _ := json.Marshal(map[string]any{
			"cluster": "no-such-cluster", "verb": "create", "group": "apps", "resource": "deployments",
		})
		return bytes.NewReader(b)
	}

	var limited bool
	for i := 0; i < 70; i++ {
		w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", body())
		if w.Code == http.StatusTooManyRequests {
			require.Contains(t, w.Body.String(), "rate-limited")
			require.NotEmpty(t, w.Header().Get("Retry-After"))
			require.Equal(t, "60", w.Header().Get("X-RateLimit-Limit"))
			limited = true
			break
		}
	}
	require.True(t, limited, "70 requests should have exhausted a 60/min budget")
}

// The validation must not reject what the deploy form actually sends — every
// pair in the client's KIND_TO_RESOURCE map.
func TestSSAR_AcceptsEveryKindTheDeployFormChecks(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	for _, tc := range []struct{ group, resource string }{
		{"apps", "deployments"},
		{"apps", "statefulsets"},
		{"apps", "daemonsets"},
		{"batch", "jobs"},
		{"batch", "cronjobs"},
		{"", "services"},
		{"networking.k8s.io", "ingresses"},
		{"", "configmaps"},
		{"", "secrets"},
		{"", "persistentvolumeclaims"},
	} {
		t.Run(tc.group+"/"+tc.resource, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"cluster":  "no-such-cluster-" + randSuffix(),
				"verb":     "create",
				"group":    tc.group,
				"resource": tc.resource,
			})
			w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
			// Past validation, so it fails on the cluster lookup instead.
			require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
		})
	}
}
