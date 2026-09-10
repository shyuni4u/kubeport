package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// The stream had no resume point, so every reconnect replayed the container log
// from the beginning. The browser reconnects on its own after any drop, and the
// pane is not cleared when it does, so the same lines piled up; the explicit
// Reconnect button avoided that only by throwing the buffer away, which cost
// the scrollback instead (#107).
//
// SSE already has the mechanism: the server puts an `id:` on each frame, the
// browser remembers the last one and sends it back as `Last-Event-ID` when it
// reconnects. That covers the reconnect nobody initiates, which is the one that
// actually hurt.

// resumeRelease opens the log stream with the given request tweak and returns
// the SSE body plus the options the fake saw.
func resumeRelease(t *testing.T, applier *fakeK8sApplier, tweak func(*http.Request)) string {
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
	tweak(req)
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
	return rec.Body.String()
}

// Every log frame carries its emission time as the SSE id. Without it the
// browser has nothing to send back and the resume below cannot start.
func TestStreamReleaseLogs_LogFramesCarryTheirTimeAsId(t *testing.T) {
	wrote := time.Date(2026, 9, 9, 7, 36, 36, 123_456_789, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logLines:  []string{"first"},
		logLineAt: wrote,
	}

	body := resumeRelease(t, applier, func(*http.Request) {})

	require.Contains(t, body, "id:"+wrote.Format(time.RFC3339Nano),
		"the log frame carried no resumable id — got: %s", body)
}

// The browser sends the id it last saw. That is the resume point, and it has to
// reach the cluster call as SinceTime or the whole log arrives again.
func TestStreamReleaseLogs_ResumesFromLastEventID(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logLines:  []string{"after the gap"},
		logLineAt: time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC),
	}
	resume := time.Date(2026, 9, 9, 7, 36, 36, 123_456_789, time.UTC)

	resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", resume.Format(time.RFC3339Nano))
	})

	require.NotNil(t, applier.sinceSeen, "the cluster call was made without a resume point")
	require.True(t, applier.sinceSeen.Equal(resume),
		"want %s, got %s", resume, applier.sinceSeen)
}

// An explicit ?since= is for callers that are not a browser — they have no
// EventSource to remember an id for them.
func TestStreamReleaseLogs_ResumesFromSinceQuery(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}},
		logLines:  []string{"x"},
		logLineAt: time.Date(2026, 9, 9, 8, 0, 0, 0, time.UTC),
	}
	resume := time.Date(2026, 9, 9, 7, 30, 0, 0, time.UTC)

	resumeRelease(t, applier, func(r *http.Request) {
		r.URL.RawQuery = "since=" + resume.Format(time.RFC3339Nano)
	})

	require.NotNil(t, applier.sinceSeen)
	require.True(t, applier.sinceSeen.Equal(resume), "want %s, got %s", resume, applier.sinceSeen)
}

// SinceTime is whole seconds, so the cluster resends everything from the second
// the client already has. The server knows the exact instant it was asked for
// and each line's own nanoseconds, so it drops that overlap itself — otherwise
// every reconnect duplicates the tail of the buffer and every client has to
// deduplicate to be correct.
func TestStreamReleaseLogs_DropsLinesTheClientAlreadyHas(t *testing.T) {
	resume := time.Date(2026, 9, 9, 7, 36, 36, 500_000_000, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}},
		// Same second as the resume point: one before it, one after.
		logLines:   []string{"already seen", "genuinely new"},
		logLineAts: []time.Time{resume.Add(-100 * time.Millisecond), resume.Add(100 * time.Millisecond)},
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", resume.Format(time.RFC3339Nano))
	})

	require.NotContains(t, body, "already seen", "a line the client already had was sent again")
	require.Contains(t, body, "genuinely new")
}

// A line with no kubelet stamp cannot be compared to the resume point. Sending
// it is a possible duplicate; dropping it loses a line outright, and the second
// is worse.
func TestStreamReleaseLogs_KeepsUnstampedLinesWhenResuming(t *testing.T) {
	resume := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances:  []k8s.Instance{{Name: "web-1"}},
		logLines:   []string{"no stamp on this one"},
		logLineAts: []time.Time{{}},
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", resume.Format(time.RFC3339Nano))
	})

	require.Contains(t, body, "no stamp on this one")
}

// A resume point we cannot parse is the caller's mistake, and answering it with
// the whole log again would hide that. The status code matters: openapi lists
// 400 for this endpoint and openapi_spec_test.go pins the pairing.
func TestStreamReleaseLogs_RejectsAnUnparseableResumePoint(t *testing.T) {
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
	require.Equal(t, http.StatusCreated, w.Code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))

	req := httptest.NewRequest(http.MethodGet,
		"/v1/releases/"+created["id"].(string)+"/logs?since=not-a-time", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code, "body: %s", rec.Body.String())
	var p map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &p))
	require.Equal(t, "validation-error", p["title"])
}

// A browser that reconnects after the stream has been idle sends the id it saw
// last, which may be minutes old — that is the point. But a client sending no
// resume point at all must still get everything, or opening the tab for the
// first time would show nothing.
func TestStreamReleaseLogs_NoResumePointStillSendsEverything(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}},
		logLines:  []string{"from the very beginning"},
		logLineAt: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(*http.Request) {})

	require.Nil(t, applier.sinceSeen, "a plain open must not ask the cluster for a window")
	require.Contains(t, body, "from the very beginning")
}
