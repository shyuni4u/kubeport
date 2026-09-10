package api_test

import (
	"bytes"
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

// Nothing used to end a log stream the reader kept open. Traefik in front has
// writeTimeout 0 and an idleTimeout the 15s ping never lets fire, and the
// stream never looked at its caller again after the handshake — so a tab left
// open kept receiving pod logs after the caller's access was revoked or their
// session expired (#169). A lifetime ends it and makes the client come back
// through a fresh authorization.

func lifetimeRouter(t *testing.T, cfg config.Config, applier *fakeK8sApplier) (*gin.Engine, string) {
	t.Helper()
	r := api.NewRouter(cfg, api.Deps{
		Verifier: adminVerifier{}, Store: testStore(t),
		K8sFactory: &fakeK8sFactory{applier: applier},
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
	return r, "/v1/releases/" + created["id"].(string) + "/logs"
}

// The stream ends by itself once its lifetime is up — and it ends as a drop,
// not a finish. An `end` frame would tell the client the pods are done and it
// should stop; the whole point is that it reconnects.
func TestStreamReleaseLogs_EndsAStreamAtItsLifetimeWithoutSayingEnd(t *testing.T) {
	// No log lines: the fake follows until its context is cancelled, like a pod
	// that is still running.
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}
	r, path := lifetimeRouter(t, config.Config{LogStreamMaxLifetime: 100 * time.Millisecond}, applier)

	done := make(chan string, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer x")
		rec := newStreamRecorder()
		r.ServeHTTP(rec, req)
		done <- rec.Body.String()
	}()

	select {
	case body := <-done:
		require.NotContains(t, body, "event:end",
			"a stream ended by its lifetime told the client the pods had finished")
	case <-time.After(5 * time.Second):
		t.Fatal("a stream past its lifetime was still open — nothing bounds how long a tab keeps receiving logs")
	}
}

// Ending by lifetime has to give the slot back, like any other way out, or a
// caller who leaves tabs open would find the cap full of streams that are gone.
func TestStreamReleaseLogs_AStreamEndedByItsLifetimeReturnsItsSlot(t *testing.T) {
	started := make(chan struct{}, 1)
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}, streamStarted: started}
	r, path := lifetimeRouter(t, config.Config{
		LogStreamsPerCaller:  1,
		LogStreamMaxLifetime: 100 * time.Millisecond,
	}, applier)

	done := make(chan struct{})
	go func() {
		defer close(done)
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer x")
		r.ServeHTTP(newStreamRecorder(), req)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the first stream never started")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the first stream did not end at its lifetime")
	}

	stop := holdStream(t, r, path, started)
	stop()
}

// The slot is taken before the pods are listed, so the lifetime has to cover
// the listing too. An apiserver that accepts the connection and never answers
// used to hold the slot for as long as it stalled — the lifetime only started
// once discovery had finished, and the cluster client has no timeout of its
// own — so a few stalled opens filled the cap and turned away streams to
// healthy clusters as well (found by codex).
func TestStreamReleaseLogs_TheLifetimeBoundsPodDiscoveryToo(t *testing.T) {
	applier := &fakeK8sApplier{instancesStall: true}
	r, path := lifetimeRouter(t, config.Config{
		LogStreamsPerCaller:  1,
		LogStreamMaxLifetime: 200 * time.Millisecond,
	}, applier)

	done := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer x")
		rec := newStreamRecorder()
		r.ServeHTTP(rec, req)
		done <- rec.Code
	}()

	select {
	case code := <-done:
		// The deferred release has run by the time the handler returns.
		require.NotEqual(t, http.StatusOK, code, "a stalled discovery was reported as a stream")
	case <-time.After(5 * time.Second):
		t.Fatal("a request stuck listing pods outlived the stream lifetime and kept its slot")
	}
}
