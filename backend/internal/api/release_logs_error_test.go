package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// streamErr is what client-go hands back when a log stream cannot be opened.
// StreamPodLogs wraps it as `pod %s: %w`, so the pod name rides along and the
// url.Error underneath spells out the apiserver's address. The whole string
// used to be written straight into the SSE frame and rendered in the log
// pane — for demo visitors too, whose password is on the landing page
// (issue #108).
var streamErr = errors.New(
	`pod web-7d9f8-x2k4l: Get "https://10.43.0.1:6443/api/v1/namespaces/demo/pods/web-7d9f8-x2k4l/log?follow=true": ` +
		`dial tcp 10.43.0.1:6443: connect: connection refused`)

// streamRecorder is a ResponseRecorder that gin's c.Stream will accept: it
// asserts its writer to http.CloseNotifier before the first iteration, and
// httptest's recorder does not implement it. The channel never fires, so the
// stream ends the way it would for a client that stays connected — when the
// handler itself decides to stop.
type streamRecorder struct {
	*httptest.ResponseRecorder
	gone chan bool
}

func newStreamRecorder() *streamRecorder {
	return &streamRecorder{ResponseRecorder: httptest.NewRecorder(), gone: make(chan bool, 1)}
}

func (s *streamRecorder) CloseNotify() <-chan bool { return s.gone }

// sseEvents splits an SSE body into (event, data) pairs.
func sseEvents(t *testing.T, body string) [][2]string {
	t.Helper()
	var out [][2]string
	var event string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			out = append(out, [2]string{event, strings.TrimSpace(strings.TrimPrefix(line, "data:"))})
		}
	}
	return out
}

// streamingRelease seeds a release whose pods exist and whose log stream fails,
// then returns the SSE body the handler produced.
func streamingRelease(t *testing.T, applier *fakeK8sApplier) string {
	t.Helper()
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
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

	req := httptest.NewRequest(http.MethodGet, "/v1/releases/"+created["id"].(string)+"/logs", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
	return rec.Body.String()
}

// The same endpoint answered with two different error schemas depending on
// whether the failure happened before or after the SSE upgrade: a Problem
// beforehand, a bare {"error": "..."} afterwards. A client had to carry two
// parsers, and the second shape had no kind, so it could not tell a retryable
// apiserver blip from a permanent denial (issue #82).
func TestStreamReleaseLogs_ErrorEventIsAProblem(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	events := sseEvents(t, streamingRelease(t, applier))

	var errData string
	for _, e := range events {
		if e[0] == "error" {
			errData = e[1]
		}
	}
	require.NotEmpty(t, errData, "expected an SSE error event, got: %v", events)

	var p map[string]any
	require.NoError(t, json.Unmarshal([]byte(errData), &p), "error frame: %s", errData)
	require.Equal(t, "k8s-error", p["title"], "the in-stream error needs the same kind vocabulary as the pre-stream one")
	require.Equal(t, float64(http.StatusBadGateway), p["status"])
	require.NotEmpty(t, p["request_id"], "the frame must be correlatable to the log line holding the real reason")
	require.NotContains(t, errData, "error\":\"pod", "the legacy {\"error\": ...} shape is gone")
}

func TestStreamReleaseLogs_ErrorEventWithholdsClusterInternals(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	body := streamingRelease(t, applier)

	for _, leak := range []string{"10.43.0.1", "6443", "web-7d9f8-x2k4l", "connection refused"} {
		require.NotContains(t, body, leak,
			"the SSE error frame exposed %q; client-go's text belongs in the server log", leak)
	}
}

// The same apiserver refusal was called two different things depending on
// which side of the SSE handshake it landed on: `cluster-auth-denied` once the
// stream was up (streamErrorKind, #82), `k8s-error` one instruction earlier,
// because listing the pods went through upstreamError, which folds everything
// into that one kind.
//
// Nothing noticed while no client branched on it. #134's client does: it hides
// [Reconnect] for permanent refusals and keeps it for retryable ones, so a
// cluster that will never accept the forwarded token arrived as the retryable
// kind, under "try again in a moment", forever.
func TestStreamReleaseLogs_ClusterRefusalKeepsItsKindBeforeTheHandshake(t *testing.T) {
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
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
	logsPath := "/v1/releases/" + created["id"].(string) + "/logs"

	forbidden := apierrors.NewForbidden(
		schema.GroupResource{Resource: "pods"}, "web-1",
		errors.New(`User "demo-admin@kubeport.local" cannot list resource "pods" in namespace "demo"`))

	for _, tc := range []struct {
		name   string
		err    error
		status int
		kind   string
	}{
		// Re-authenticating against kubeport cannot help: it is the cluster
		// that refused, the distinction #83 drew for the OpenAPI proxy.
		{"apiserver 401", apierrors.NewUnauthorized("token expired"), http.StatusBadGateway, "cluster-auth-denied"},
		// The caller may read the release but not its pods. Permanent until
		// someone changes the cluster's RBAC.
		{"apiserver 403", forbidden, http.StatusForbidden, "rbac-denied"},
		// Transport and everything else: worth retrying.
		{"transport failure", streamErr, http.StatusBadGateway, "k8s-error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			applier.instancesErr = tc.err
			t.Cleanup(func() { applier.instancesErr = nil })

			w := do(t, r, http.MethodGet, logsPath, nil)

			require.Equal(t, tc.status, w.Code, "body: %s", w.Body.String())
			var p map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p), "body: %s", w.Body.String())
			require.Equal(t, tc.kind, p["title"],
				"the handshake must not change what this failure is called")
			require.NotEmpty(t, p["request_id"])
		})
	}
}

// The pre-stream path used to hand back client-go's own text whenever the
// apiserver had answered (upstreamError keeps it deliberately, so a deploy
// refusal can explain itself). This endpoint made the opposite call in #108
// and the two sides should not disagree about the same release.
func TestStreamReleaseLogs_ListFailureWithholdsClusterInternals(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		instancesErr: streamErr,
	}
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
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

	w = do(t, r, http.MethodGet, "/v1/releases/"+created["id"].(string)+"/logs", nil)

	require.Equal(t, http.StatusBadGateway, w.Code)
	for _, leak := range []string{"10.43.0.1", "6443", "web-7d9f8-x2k4l", "connection refused"} {
		require.NotContains(t, w.Body.String(), leak,
			"the refusal exposed %q; client-go's text belongs in the server log", leak)
	}
}

// Opening a stream lists the release's pods and follows one log per pod, so it
// is the same control-plane fan-out #73 put a budget on — the route was simply
// missed. #134 raised the cost of a refusal, because the client now re-asks for
// the URL to read the Problem EventSource hid from it.
func TestStreamReleaseLogs_IsOnTheUpstreamBudget(t *testing.T) {
	applier := &fakeK8sApplier{instancesErr: streamErr}
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
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
	applier.instancesErr = nil
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "seed release: %s", w.Body.String())
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	// Fail the list so each attempt ends immediately instead of opening a
	// stream this test would then have to drain.
	applier.instancesErr = streamErr
	logsPath := "/v1/releases/" + created["id"].(string) + "/logs"

	var limited bool
	for i := 0; i < 70; i++ {
		w := do(t, r, http.MethodGet, logsPath, nil)
		if w.Code == http.StatusTooManyRequests {
			require.Contains(t, w.Body.String(), "rate-limited")
			require.NotEmpty(t, w.Header().Get("Retry-After"),
				"a 429 must say how long to wait, or a program guesses")
			limited = true
			break
		}
	}
	require.True(t, limited, "70 stream opens should have exhausted a 60/min budget")
}

// #82 also claims the stream stays open after an error. It does not: errCh
// closes once every pod goroutine has returned and the loop ends. What was
// actually broken is the ordering — StreamPodLogs buffers the error and only
// then closes both channels, so select saw two ready cases and picked
// uniformly, dropping the error frame about half the time.
//
// So the assertion is that the error is flushed *before* the close, not merely
// that the handler returns. "It returned" passes with the bug still in, and a
// genuine hang would show up as a package-wide 10-minute timeout with no
// message rather than as this test failing.
func TestStreamReleaseLogs_FlushesTheErrorBeforeClosing(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	done := make(chan string, 1)
	go func() { done <- streamingRelease(t, applier) }()

	var body string
	select {
	case body = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stream never closed: the callback kept returning true after both channels closed")
	}

	events := sseEvents(t, body)
	require.NotEmpty(t, events, "the stream closed without emitting anything")
	// The error is now second-to-last rather than last: #162 added an `end`
	// frame so the client can tell a finished stream from a dropped one. The
	// property under test is unchanged — the error must still be written before
	// the stream stops, not raced by the close.
	require.Equal(t, "error", events[len(events)-2][0],
		"the buffered error must be flushed before the close, not raced by it")
	require.Equal(t, "end", events[len(events)-1][0], "got: %v", events)
}
