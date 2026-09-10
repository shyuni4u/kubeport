package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

// A stream following several pods emits no ids at all.
//
// StreamPodLogs fans the pods into one channel with no ordering, so the last id
// a client saw is whichever pod wrote last — not a watermark across all of
// them. Handing that back would resume every pod from it, and a pod that was
// still replaying older history would have the rest of it skipped: silently,
// permanently, and invisibly to the reader. No id means the client keeps
// replaying, which is what it did before and costs only bandwidth (#107, #172).
func TestStreamReleaseLogs_NoResumeIdsWhenFollowingSeveralPods(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:  []string{"a line"},
		logLineAt: time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(*http.Request) {})

	require.Contains(t, body, "a line")
	require.NotContains(t, body, "id:",
		"a multi-pod stream handed out a resume point one pod's clock cannot stand for")
}

// ...and it ignores one if a client sends it anyway. The header survives across
// a reconnect on the same EventSource, so a reader who switches from a single
// instance to "all" carries the old id with them.
func TestStreamReleaseLogs_IgnoresAResumePointForSeveralPods(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:  []string{"older history"},
		logLineAt: time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", "2026-09-09T12:00:00Z")
	})

	require.Nil(t, applier.sinceSeen, "asked the cluster for a window it cannot honour per-pod")
	require.Contains(t, body, "older history", "history a slower pod had not reached was dropped")
}

// An unstamped line must not advance the cursor. `at` falls back to now so the
// row has something to render, but putting that in the id would tell the browser
// it had read up to the present — and a drop right after would skip whatever
// history was still on its way.
func TestStreamReleaseLogs_AnUnstampedLineDoesNotAdvanceTheResumePoint(t *testing.T) {
	stamped := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances:  []k8s.Instance{{Name: "web-1"}},
		logLines:   []string{"stamped", "not stamped"},
		logLineAts: []time.Time{stamped, {}},
	}

	body := resumeRelease(t, applier, func(*http.Request) {})

	require.Contains(t, body, "id:"+stamped.Format(time.RFC3339Nano))
	require.Equal(t, 1, strings.Count(body, "id:"),
		"the unstamped line carried an id, which would move the cursor to now — got: %s", body)
}
