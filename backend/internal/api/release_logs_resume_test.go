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
// the SSE body. The fake records what the handler passed down.
func resumeRelease(t *testing.T, applier *fakeK8sApplier, tweak func(*http.Request)) string {
	t.Helper()
	return resumeReleaseAt(t, applier, "", tweak)
}

// resumeReleaseAt is the same with a query string, for the cases that turn on
// which instance was asked for.
func resumeReleaseAt(t *testing.T, applier *fakeK8sApplier, query string, tweak func(*http.Request)) string {
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

	req := httptest.NewRequest(http.MethodGet,
		"/v1/releases/"+created["id"].(string)+"/logs"+query, nil)
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

	body := resumeReleaseAt(t, applier, "?instance=web-7d9f8-x2k4l", func(*http.Request) {})

	require.Contains(t, body, "id:"+wrote.UTC().Format(idLayout),
		"the log frame carried no resumable id — got: %s", body)
}

// idLayout mirrors the handler's resumeIDLayout: UTC, nine fractional digits.
// Written out here rather than imported so the test states the contract a
// caller relies on, instead of agreeing with whatever the code happens to say.
const idLayout = "2006-01-02T15:04:05.000000000Z07:00"

// The id's shape is part of the contract, not an accident of Go's formatter.
// RFC3339Nano trims trailing zeros and keeps the kubelet's offset, so a
// whole-second stamp came out as "…:36Z" and a +09:00 one as "…+09:00" — ids of
// varying length in varying zones, whose string order is not their time order.
// A caller that picks the greatest id it has seen as its cursor, which is the
// natural thing to do with a value that looks sortable, would then resume past
// lines it never received.
func TestStreamReleaseLogs_IdsAreFixedWidthUTC(t *testing.T) {
	seoul := time.FixedZone("KST", 9*60*60)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}},
		logLines:  []string{"whole second, not UTC", "tenth of a second"},
		logLineAts: []time.Time{
			time.Date(2026, 9, 9, 16, 36, 36, 0, seoul),
			time.Date(2026, 9, 9, 7, 36, 36, 100_000_000, time.UTC),
		},
	}

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(*http.Request) {})

	require.Contains(t, body, "id:2026-09-09T07:36:36.000000000Z\n")
	require.Contains(t, body, "id:2026-09-09T07:36:36.100000000Z\n")
}

// `?since=` on an `instance=all` stream is refused rather than ignored. The
// caller wrote it; a 200 with the whole log would look like a working resume
// while every reconnect duplicated. Tightening this later would break whoever
// had come to rely on the silence, so it is strict from the first release.
func TestStreamReleaseLogs_RefusesSinceWithoutANamedInstance(t *testing.T) {
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
		"/v1/releases/"+created["id"].(string)+"/logs?since=2026-09-09T07:00:00Z", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code, "body: %s", rec.Body.String())
	var p map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &p))
	require.Equal(t, "validation-error", p["title"])
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

	resumeReleaseAt(t, applier, "?instance=web-7d9f8-x2k4l", func(r *http.Request) {
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

	resumeReleaseAt(t, applier, "?instance=web-1", func(r *http.Request) {
		r.URL.RawQuery += "&since=" + resume.Format(time.RFC3339Nano)
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

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(r *http.Request) {
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

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(*http.Request) {})

	require.Contains(t, body, "id:"+stamped.UTC().Format(idLayout))
	require.Equal(t, 1, strings.Count(body, "id:"),
		"the unstamped line carried an id, which would move the cursor to now — got: %s", body)
}

// `all` matching a single pod must still not resume.
//
// A one-replica release rolls over: the client was following pod A through
// `instance=all`, A goes away, B takes its place. The reconnect matches one pod
// either time, so a count-based gate stays on — and hands B the cursor A had
// reached, dropping whatever B wrote before that instant. Which pods `all`
// covers is not fixed, so nothing derived from one of them can be carried
// across a reconnect (#172).
func TestStreamReleaseLogs_AllDoesNotResumeEvenWithOnePod(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-after-rollout"}},
		logLines:  []string{"the replacement pod's startup"},
		logLineAt: time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		// The cursor the client reached on the pod that is now gone.
		r.Header.Set("Last-Event-ID", "2026-09-09T12:00:00Z")
	})

	require.Nil(t, applier.sinceSeen,
		"a cursor from one pod was applied to the pod that replaced it")
	require.Contains(t, body, "the replacement pod's startup")
	require.NotContains(t, body, "id:", "an `all` stream handed out a resume point")
}

// ...and naming the instance is what turns it on. The name is in the URL, so it
// means the same pod on every reconnect — and if that pod is gone the request
// is a 404, not a different pod inheriting its cursor.
func TestStreamReleaseLogs_NamingAnInstanceResumes(t *testing.T) {
	resume := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:  []string{"only this pod"},
		logLineAt: resume.Add(time.Minute),
	}

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(r *http.Request) {
		r.Header.Set("Last-Event-ID", resume.Format(time.RFC3339Nano))
	})

	require.NotNil(t, applier.sinceSeen, "a named instance did not resume")
	require.True(t, applier.sinceSeen.Equal(resume))
	require.Contains(t, body, "id:")
}

// A `Last-Event-ID` we cannot read starts the stream over instead of refusing.
//
// Nobody typed that value. The browser attaches it on every automatic
// reconnect and nothing on the page can clear it, so a 400 here would repeat
// for as long as the tab stays open — and a non-2xx makes EventSource give up,
// leaving a dead log pane the reader cannot revive without reloading. It is
// also going to happen for real: the day the id format changes (#172), tabs
// opened before the deploy carry the old shape into the new server.
func TestStreamReleaseLogs_AnUnreadableLastEventIDStartsOver(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}},
		logLines:  []string{"from the top"},
		logLineAt: time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC),
	}

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(r *http.Request) {
		r.Header.Set("Last-Event-ID", "web-1@2026-09-09T07:00:00Z,web-2@2026-09-09T07:01:00Z")
	})

	require.Nil(t, applier.sinceSeen, "an unreadable header was turned into a window")
	require.Contains(t, body, "from the top")
}

// ...while the same garbage in `?since=` is still refused. That one the caller
// wrote, and a 200 with the whole log would let them go on sending it.
func TestStreamReleaseLogs_AnUnreadableSinceIsStillRefused(t *testing.T) {
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
		"/v1/releases/"+created["id"].(string)+"/logs?instance=web-1&since=garbage", nil)
	req.Header.Set("Authorization", "Bearer x")
	// A perfectly good header alongside must not rescue a bad explicit value.
	req.Header.Set("Last-Event-ID", "2026-09-09T07:00:00Z")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code, "body: %s", rec.Body.String())
}

// Input the request alone can refute is refuted before the cluster is asked
// anything. Otherwise every malformed `?since=` costs an apiserver pod LIST
// under the caller's token before it is turned away.
func TestStreamReleaseLogs_RefusesBadInputBeforeTouchingTheCluster(t *testing.T) {
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}
	factory := &fakeK8sFactory{applier: applier}
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: factory,
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
	callsBefore := factory.calls

	req := httptest.NewRequest(http.MethodGet,
		"/v1/releases/"+created["id"].(string)+"/logs?since=garbage", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Equal(t, callsBefore, factory.calls,
		"a request refutable from its own query string still built a cluster client")
}
