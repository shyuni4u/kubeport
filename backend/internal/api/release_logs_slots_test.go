package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// Opening a log stream spends one rate-limit token; holding it spends nothing.
// So the existing budget bounds how often a caller opens streams and says
// nothing about how many it keeps open — and each one keeps a goroutine per pod
// and an apiserver connection alive for as long as the tab stays open. The demo
// makes that everyone's problem: its two Dex identities are shared by every
// visitor, so the cap per caller is, for the demo, nearly a global cap (#169).

// slotRouter builds a router with the given per-caller cap and seeds one
// release, returning the router, its logs path, and the factory so a test can
// tell whether a cluster client was ever built.
func slotRouter(t *testing.T, cap int, applier *fakeK8sApplier) (*gin.Engine, string, *fakeK8sFactory) {
	t.Helper()
	factory := &fakeK8sFactory{applier: applier}
	r := api.NewRouter(config.Config{LogStreamsPerCaller: cap}, api.Deps{
		Verifier: adminVerifier{}, Store: testStore(t), K8sFactory: factory,
	})
	cluster := seedCluster(t, r)
	tpl := seedPublishedTemplate(t, r)
	body, _ := json.Marshal(map[string]any{
		"template": tpl, "version": 1,
		"cluster": cluster, "namespace": "default",
		"name":   "logs-" + randSuffix(),
		"values": map[string]any{"Deployment[web].spec.replicas": 1},
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed release: %s", w.Body.String())
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	return r, "/v1/releases/" + created["id"].(string) + "/logs", factory
}

// holdStream opens a stream in the background and blocks until the handler has
// actually started streaming. The returned func ends it and waits for the
// handler to return.
func holdStream(t *testing.T, r http.Handler, path string, started <-chan struct{}) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer x")
		r.ServeHTTP(newStreamRecorder(), req)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("the held stream never started")
	}
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the held stream did not end after its context was cancelled")
		}
	}
}

func openOnce(r http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestStreamReleaseLogs_RefusesAStreamPastTheCallersCap(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path, factory := slotRouter(t, 1, applier)

	stop := holdStream(t, r, path, started)
	defer stop()

	callsBefore := factory.calls
	rec := openOnce(r, path)

	require.Equal(t, http.StatusTooManyRequests, rec.Code, "body: %s", rec.Body.String())
	var p map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &p))
	// Its own kind, not rate-limited: a rate clears with time and this clears
	// when a stream closes, and the UI's sentence and a client's retry policy
	// both depend on knowing which.
	require.Equal(t, "too-many-streams", p["title"])
	// openapi.yaml's RateLimited says Retry-After is "always present on a 429",
	// and docs/machine-clients.md tells callers to honour it.
	require.NotEmpty(t, rec.Header().Get("Retry-After"))
	// ...but not the X-RateLimit-* pair. Those are documented as requests per
	// minute, and this refusal is about streams held, not a rate — a Limit of
	// "16" here would read as sixteen requests a minute and be wrong.
	require.Empty(t, rec.Header().Get("X-RateLimit-Limit"))
	require.Empty(t, rec.Header().Get("X-RateLimit-Remaining"))
	// A refusal that already knows the answer must not cost the cluster a call.
	require.Equal(t, callsBefore, factory.calls,
		"a stream refused for being over the cap still built a cluster client")
}

// The cap is on streams held, so ending one has to make room.
func TestStreamReleaseLogs_EndingAStreamReturnsItsSlot(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path, _ := slotRouter(t, 1, applier)

	stop := holdStream(t, r, path, started)
	stop()

	stop = holdStream(t, r, path, started)
	stop()
}

// A request that takes a slot and is then turned away — here because the pod it
// named does not exist — must give the slot back. Otherwise every 404 a tab ever
// received would count against that caller for good.
func TestStreamReleaseLogs_ARefusalAfterTakingASlotGivesItBack(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path, _ := slotRouter(t, 1, applier)

	for range 3 {
		rec := openOnce(r, path+"?instance=ghost")
		require.Equal(t, http.StatusNotFound, rec.Code, "body: %s", rec.Body.String())
	}

	stop := holdStream(t, r, path, started)
	stop()
}

// The default has to leave ordinary use alone. Two tabs on the same release —
// the overview in one, the logs in another — is normal, not abuse.
func TestStreamReleaseLogs_DefaultCapAllowsSeveralTabs(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path, _ := slotRouter(t, 0, applier)

	var stops []func()
	for range 4 {
		stops = append(stops, holdStream(t, r, path, started))
	}
	for _, stop := range stops {
		stop()
	}
}
