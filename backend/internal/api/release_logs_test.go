package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// TestStreamReleaseLogs_NotFound: unknown release id returns 404. The
// response must NOT have an event-stream content type — error path
// comes before SSE upgrade.
func TestStreamReleaseLogs_NotFound(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)

	w := do(t, r, http.MethodGet, "/v1/releases/00000000-0000-0000-0000-000000000000/logs", nil)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
	if strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("error response should not be event-stream; got %q", w.Header().Get("Content-Type"))
	}
}

// TestStreamReleaseLogs_BadID: malformed id returns 400.
func TestStreamReleaseLogs_BadID(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)

	w := do(t, r, http.MethodGet, "/v1/releases/not-a-uuid/logs", nil)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// TestStreamReleaseLogs_NonOwnerReturns403: a non-admin user requesting
// logs for a release they do not own gets 403, not a stream. Pod logs
// can leak secrets/PII so the check must mirror GET /v1/releases/:id.
func TestStreamReleaseLogs_NonOwnerReturns403(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}

	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	relName := "nologs-" + randSuffix()
	body, _ := json.Marshal(map[string]any{
		"template": tplName, "version": 1,
		"cluster": clusterName, "namespace": "default",
		"name": relName, "values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code)

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created["id"].(string)

	userRouter := newTestRouterUserWithK8s(t, s, applier)
	w = do(t, userRouter, http.MethodGet, "/v1/releases/"+id+"/logs", nil)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "not the release owner")
	require.False(
		t,
		strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream"),
		"403 must not be event-stream",
	)
}
