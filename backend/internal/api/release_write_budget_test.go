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

// Issue #232. Creating, updating and deleting a release each drive several
// calls against the target apiserver — a dry-run and an apply per object, or a
// DeleteCollection per kind — and none of them had a per-caller budget. They
// share one bucket of their own: a person submits the deploy form or presses
// delete once, so 30/min never refuses a human, while a loop is held to one
// write every two seconds.
//
// The limiter runs before the handler, so a request the handler would refuse
// still spends a token. The bodies here are refused before anything reaches a
// cluster or the database.
//
// Nothing assumes the loop beats the refill (a token every 2s): the test pins
// which budget refuses (X-RateLimit-Limit) and that at least the burst got
// through first.
func TestReleaseWrites_ShareTheirOwnBudget(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "writer-" + randSuffix(), Email: "writer@example.com",
		}},
		Store: testStore(t),
	})
	const missing = "/v1/releases/00000000-0000-4000-8000-000000000232"

	served := 0
	var refused *http.Response
	for i := 0; i < 60; i++ {
		// Not JSON: a 400 from binding, after the limiter has spent a token.
		w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader([]byte("{")))
		if w.Code == http.StatusTooManyRequests {
			require.Contains(t, w.Body.String(), "rate-limited")
			refused = w.Result()
			break
		}
		require.Equal(t, http.StatusBadRequest, w.Code, "request %d: %s", i+1, w.Body.String())
		served++
	}
	require.NotNil(t, refused, "60 creates should have exhausted a 30/min budget")
	require.GreaterOrEqual(t, served, 30, "refused inside the 30 burst, after %d", served)
	require.NotEmpty(t, refused.Header.Get("Retry-After"))
	require.Equal(t, "30", refused.Header.Get("X-RateLimit-Limit"))

	// Update and delete draw on the same bucket, so a loop cannot switch verbs
	// to get a fresh one.
	w := do(t, r, http.MethodPut, missing, bytes.NewReader([]byte(`{"version":1,"values":{}}`)))
	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	w = do(t, r, http.MethodDelete, missing, nil)
	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())

	// Writes must not starve reading a release or the deploy form's
	// permission check.
	w = do(t, r, http.MethodGet, missing, nil)
	require.NotEqual(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	body, _ := json.Marshal(map[string]any{
		"cluster": "no-such-cluster", "verb": "create", "group": "apps", "resource": "deployments",
	})
	w = do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.NotEqual(t, http.StatusTooManyRequests, w.Code, w.Body.String())
}
