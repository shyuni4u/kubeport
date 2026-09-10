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
// The token is spent inside the handler, just before the first cluster call.
// On the demo every visitor shares one identity, so a bucket that requests
// refused for free could drain would lock everyone out — the reset seeder
// included (security review).
//
// Nothing assumes the loop beats the refill (a token every 2s): the test pins
// which budget refuses (X-RateLimit-Limit) and that at least the burst got
// through first.
func TestReleaseWrites_ShareTheirOwnBudget(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	suffix := randSuffix()
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "writer-" + suffix, Email: "writer-" + suffix + "@example.com",
		}},
		Store:      s,
		K8sFactory: &fakeK8sFactory{applier: &fakeK8sApplier{}},
	})

	// Refused before any cluster call, so they must not spend the budget.
	for i := 0; i < 40; i++ {
		w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader([]byte("{")))
		require.Equal(t, http.StatusBadRequest, w.Code, "malformed create %d: %s", i+1, w.Body.String())
	}

	served := 0
	lastID := ""
	var refused *http.Response
	for i := 0; i < 45; i++ {
		w := do(t, r, http.MethodPost, "/v1/releases", deployBody(t, tplName, clusterName, "budget-"+randSuffix()))
		if w.Code == http.StatusTooManyRequests {
			require.Contains(t, w.Body.String(), "rate-limited")
			refused = w.Result()
			break
		}
		require.Equal(t, http.StatusCreated, w.Code, "create %d: %s", i+1, w.Body.String())
		var created struct {
			ID string `json:"id"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
		lastID = created.ID
		served++
	}
	require.NotNil(t, refused, "45 creates should have exhausted a 30/min budget")
	require.GreaterOrEqual(t, served, 30,
		"refused inside the 30 burst after %d — did the malformed creates spend it?", served)
	require.NotEmpty(t, refused.Header.Get("Retry-After"))
	require.Equal(t, "30", refused.Header.Get("X-RateLimit-Limit"))

	// Update and delete draw on the same bucket, so a loop cannot switch verbs
	// to get a fresh one.
	release := "/v1/releases/" + lastID
	w := do(t, r, http.MethodPut, release,
		bytes.NewReader([]byte(`{"version":1,"values":{"Deployment[web].spec.replicas":1}}`)))
	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	w = do(t, r, http.MethodDelete, release, nil)
	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())

	// Writes must not starve reading a release or the deploy form's
	// permission check.
	w = do(t, r, http.MethodGet, release, nil)
	require.NotEqual(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	body, _ := json.Marshal(map[string]any{
		"cluster": "no-such-cluster", "verb": "create", "group": "apps", "resource": "deployments",
	})
	w = do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.NotEqual(t, http.StatusTooManyRequests, w.Code, w.Body.String())
}
