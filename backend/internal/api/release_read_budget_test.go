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

// Issue #212. GET /v1/releases/:id lists the release's pods on the target
// apiserver on every call, and it was the one control-plane read with no
// budget at all. It gets a bucket of its own rather than a seat on `upstream`:
// the release list probes one row per release and a settling detail tab
// re-reads on a backoff, so on the demo's shared identity those reads would
// otherwise starve the log-stream opens and the deploy form's SSAR fan-out.
//
// The id is a well-formed UUID no release has. The limiter runs before the
// handler, so each request still spends a token, and the handler answers 404
// from the database without reaching a cluster.
//
// Nothing here assumes the loop beats the refill. The bucket gains a token
// every 250ms, and each request is a real database round trip, so on a slow
// runner the refusal can come a few requests after the 240th. What the test
// pins is which budget refuses (X-RateLimit-Limit) and that it is not the
// 60/min one (more than 60 requests got through first).
func TestGetRelease_HasItsOwnReadBudget(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "reader-" + randSuffix(), Email: "reader@example.com",
		}},
		Store: testStore(t),
	})
	const missing = "/v1/releases/00000000-0000-4000-8000-000000000212"

	served := 0
	var refused *http.Response
	for i := 0; i < 400; i++ {
		w := do(t, r, http.MethodGet, missing, nil)
		if w.Code == http.StatusTooManyRequests {
			require.Contains(t, w.Body.String(), "rate-limited")
			refused = w.Result()
			break
		}
		require.Equal(t, http.StatusNotFound, w.Code, "request %d: %s", i+1, w.Body.String())
		served++
	}
	require.NotNil(t, refused, "400 reads should have exhausted a 240/min budget")
	require.GreaterOrEqual(t, served, 240,
		"a 60/min seat on `upstream` would have refused after 60; refused after %d", served)
	require.NotEmpty(t, refused.Header.Get("Retry-After"), "a 429 must say how long to wait")
	require.Equal(t, "240", refused.Header.Get("X-RateLimit-Limit"))

	// Spent reads must not have spent the control-plane budget the deploy
	// form's permission check draws on.
	body, _ := json.Marshal(map[string]any{
		"cluster": "no-such-cluster", "verb": "create", "group": "apps", "resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.NotEqual(t, http.StatusTooManyRequests, w.Code, w.Body.String())
}
