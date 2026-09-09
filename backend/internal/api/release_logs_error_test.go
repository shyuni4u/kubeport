package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

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

// #82 also claims the stream stays open after an error. It does not: errCh is
// closed once every pod goroutine has returned, and the next select reads the
// closed channel and ends the stream. This pins that, so the claim is settled
// by the code rather than re-argued.
func TestStreamReleaseLogs_StreamEndsAfterTerminalError(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	// The handler returning at all is the assertion: c.Stream loops until a
	// callback returns false, so a stream left open would hang here.
	events := sseEvents(t, streamingRelease(t, applier))
	require.NotEmpty(t, events)
}
