package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// refusedAt opens the log stream with the given query and returns the recorder,
// for the cases that expect the request to be turned away.
func refusedAt(t *testing.T, applier *fakeK8sApplier, query string) *streamRecorder {
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
	require.Equal(t, http.StatusCreated, w.Code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))

	req := httptest.NewRequest(http.MethodGet,
		"/v1/releases/"+created["id"].(string)+"/logs"+query, nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := newStreamRecorder()
	r.ServeHTTP(rec, req)
	return rec
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

// A plain instant in `?since=` on an `instance=all` stream is refused rather
// than ignored. The caller wrote it, and one instant applied to every pod is
// exactly the resume that loses lines (#172) — while a 200 with the whole log
// would look like a working resume as every reconnect duplicated.
func TestStreamReleaseLogs_RefusesAPlainSinceOnAll(t *testing.T) {
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}

	rec := refusedAt(t, applier, "?since=2026-09-09T07:00:00Z")

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

	body := resumeReleaseAt(t, applier, "?instance=web-1", func(r *http.Request) {
		r.Header.Set("Last-Event-ID", resume.Format(time.RFC3339Nano))
	})

	require.Contains(t, body, "no stamp on this one")
}

// A resume point we cannot parse is the caller's mistake, and answering it with
// the whole log again would hide that. The status code matters: openapi lists
// 400 for this endpoint and openapi_spec_test.go pins the pairing.
func TestStreamReleaseLogs_RejectsAnUnparseableResumePoint(t *testing.T) {
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}

	rec := refusedAt(t, applier, "?since=not-a-time")

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

// cursor writes an `instance=all` resume point in the contract's shape: pod@time
// pairs sorted by pod, each time UTC with nine fractional digits. Spelled out
// here rather than calling the handler's formatter, for the reason idLayout is.
func cursor(pairs ...any) string {
	var items []string
	for i := 0; i < len(pairs); i += 2 {
		items = append(items, pairs[i].(string)+"@"+pairs[i+1].(time.Time).UTC().Format(idLayout))
	}
	return strings.Join(items, ",")
}

// #172 — an `instance=all` stream carries a cursor as its id: every pod's
// position, not only the pod that wrote the line. The browser keeps just the
// last id, so that one id has to say how far each pod got; a lone instant, the
// newest line's, would stand for whichever pod wrote last.
func TestStreamReleaseLogs_AllCarriesAPerPodCursor(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	web2 := time.Date(2026, 9, 9, 7, 35, 0, 900_000_000, time.UTC)
	applier := &fakeK8sApplier{
		instances:   []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:    []string{"from web-1", "from web-2"},
		logLinePods: []string{"web-1", "web-2"},
		logLineAts:  []time.Time{web1, web2},
	}

	body := resumeRelease(t, applier, func(*http.Request) {})

	require.Contains(t, body, "id:"+cursor("web-1", web1)+"\n")
	require.Contains(t, body, "id:"+cursor("web-1", web1, "web-2", web2)+"\n",
		"the second frame's id did not carry both pods — got: %s", body)
}

// ...and hands it back per pod. Each pod picks up from its own position: web-2
// had only reached 07:30 when web-1 was at 07:40, and resuming both from 07:40
// would skip web-2's ten minutes for good.
func TestStreamReleaseLogs_AllResumesEachPodFromItsOwnPosition(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC)
	web2 := time.Date(2026, 9, 9, 7, 30, 0, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		// A line to send lets the fake stream end; with none it follows forever.
		logLines:  []string{"after the gap"},
		logLineAt: web1.Add(time.Minute),
	}

	resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-1", web1, "web-2", web2))
	})

	require.Len(t, applier.sinceByPod, 2, "want a start point per pod, got %v", applier.sinceByPod)
	require.True(t, applier.sinceByPod["web-1"].Equal(web1), "web-1: %s", applier.sinceByPod["web-1"])
	require.True(t, applier.sinceByPod["web-2"].Equal(web2), "web-2: %s", applier.sinceByPod["web-2"])
}

// The overlap trim is per pod as well. A single instant would have dropped
// web-2's 07:35 line — later than web-2's own position, earlier than web-1's.
func TestStreamReleaseLogs_AllTrimsEachPodAgainstItsOwnPosition(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 40, 0, 500_000_000, time.UTC)
	web2 := time.Date(2026, 9, 9, 7, 30, 0, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances:   []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:    []string{"web-1 already had this", "web-2 had not reached this", "web-1 genuinely new"},
		logLinePods: []string{"web-1", "web-2", "web-1"},
		logLineAts: []time.Time{
			web1.Add(-100 * time.Millisecond),
			time.Date(2026, 9, 9, 7, 35, 0, 0, time.UTC),
			web1.Add(100 * time.Millisecond),
		},
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-1", web1, "web-2", web2))
	})

	require.NotContains(t, body, "web-1 already had this")
	require.Contains(t, body, "web-2 had not reached this",
		"a slower pod's line was trimmed against another pod's position")
	require.Contains(t, body, "web-1 genuinely new")
}

// A pod that has not written since the reconnect keeps its place in the next
// id. Otherwise a second drop before it writes would lose its position and
// replay it from the start.
func TestStreamReleaseLogs_AllKeepsTheCursorOfAPodThatHasNotWrittenYet(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC)
	web2 := time.Date(2026, 9, 9, 7, 30, 0, 0, time.UTC)
	later := web1.Add(time.Minute)
	applier := &fakeK8sApplier{
		instances:   []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:    []string{"only web-1 writes"},
		logLinePods: []string{"web-1"},
		logLineAts:  []time.Time{later},
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-1", web1, "web-2", web2))
	})

	require.Contains(t, body, "id:"+cursor("web-1", later, "web-2", web2)+"\n")
}

// The set `all` covers is not fixed. A pod the cursor does not name — one that
// started since — has no position, so it is sent from the beginning.
func TestStreamReleaseLogs_AllSendsANewPodFromTheBeginning(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-3"}},
		logLines:  []string{"after the gap"},
		logLineAt: web1.Add(time.Minute),
	}

	resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-1", web1))
	})

	require.Contains(t, applier.sinceByPod, "web-1")
	require.NotContains(t, applier.sinceByPod, "web-3", "a pod the cursor never saw was given a start point")
}

// ...and a position for a pod that is gone is dropped, not handed to the pod
// that replaced it. A one-replica release rolls over: the cursor holds pod A's
// position, B now stands where A did, and applying A's to B would drop
// whatever B wrote before that instant.
func TestStreamReleaseLogs_AllDropsTheCursorOfAPodThatHasGone(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-after-rollout"}},
		logLines:  []string{"the replacement pod's startup"},
		logLineAt: time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-before-rollout", time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)))
	})

	require.Nil(t, applier.sinceSeen, "a departed pod's position was applied to its replacement")
	require.Contains(t, body, "the replacement pod's startup")
}

// A plain instant in the header on an `all` stream is ignored, not refused. The
// browser keeps Last-Event-ID across a switch from one instance to `all` on the
// same EventSource, so this is what such a switch sends — and one instant is
// the resume `all` must not do.
func TestStreamReleaseLogs_AllIgnoresAPlainInstantInTheHeader(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:  []string{"older history"},
		logLineAt: time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", "2026-09-09T12:00:00Z")
	})

	require.Nil(t, applier.sinceSeen, "asked the cluster for a window one instant cannot honour per pod")
	require.Contains(t, body, "older history", "history a slower pod had not reached was dropped")
	require.Contains(t, body, "event:replay", "starting over despite a resume point went unannounced")
}

// A caller with no EventSource hands the same cursor back as `?since=`.
func TestStreamReleaseLogs_AllResumesFromACursorInSince(t *testing.T) {
	web1 := time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:  []string{"after the gap"},
		logLineAt: web1.Add(time.Minute),
	}

	resumeRelease(t, applier, func(r *http.Request) {
		r.URL.RawQuery = "since=" + cursor("web-1", web1)
	})

	require.Len(t, applier.sinceByPod, 1)
	require.True(t, applier.sinceByPod["web-1"].Equal(web1))
}

// The cursor rides on every frame, so it is bounded. Past the bound an `all`
// stream hands out no cursor and does not act on one either, since the next
// reconnect would bring back an id it no longer hands out. It says it is
// starting over, so a client that kept its lines can drop them first (#172).
func TestStreamReleaseLogs_AllPastTheCursorBoundReplaysAndSaysSo(t *testing.T) {
	var instances []k8s.Instance
	for i := 0; i < 9; i++ {
		instances = append(instances, k8s.Instance{Name: fmt.Sprintf("web-%d", i)})
	}
	applier := &fakeK8sApplier{
		instances: instances,
		logLines:  []string{"a line"},
		logLineAt: time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC),
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-0", time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC)))
	})

	require.Nil(t, applier.sinceSeen, "a stream past the cursor bound resumed from a cursor")
	require.Contains(t, body, "a line")
	require.Contains(t, body, "event:replay", "a stream that ignored the cursor it was sent did not say so")
	require.Contains(t, body, "id:-\n", "a stream past the cursor bound left the browser's old cursor standing")
	require.NotContains(t, body, "@2026", "a stream past the cursor bound handed out a cursor")
}

// ...and coming back under the bound does not resume from the cursor the
// browser kept from before it went over: the placeholder replaced it, so the
// stream starts over and says so, instead of resending the lines since that old
// cursor into a pane the replay already filled.
func TestStreamReleaseLogs_AllBackUnderTheBoundStartsOverFromThePlaceholder(t *testing.T) {
	at := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	applier := &fakeK8sApplier{
		instances:   []k8s.Instance{{Name: "web-1"}, {Name: "web-2"}},
		logLines:    []string{"from the top"},
		logLinePods: []string{"web-1"},
		logLineAt:   at,
	}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", "-")
	})

	require.Nil(t, applier.sinceSeen)
	require.Contains(t, body, "event:replay")
	require.Contains(t, body, "id:"+cursor("web-1", at)+"\n", "back under the bound, the cursor did not return")
}

// The `replay` frame carries the placeholder id itself. It empties the pane, so
// the resume point the browser still holds must go at the same moment: a drop
// before the first stamped line would otherwise send the old cursor back, and
// once the release is under the bound again that cursor would be applied —
// resuming past lines the emptied pane no longer has.
func TestStreamReleaseLogs_TheReplayFrameReplacesTheBrowsersResumePoint(t *testing.T) {
	var instances []k8s.Instance
	for i := 0; i < maxPodsInTest; i++ {
		instances = append(instances, k8s.Instance{Name: fmt.Sprintf("web-%d", i)})
	}
	applier := &fakeK8sApplier{instances: instances, logLines: []string{"unstamped"}, logLineAts: []time.Time{{}}}

	body := resumeRelease(t, applier, func(r *http.Request) {
		r.Header.Set("Last-Event-ID", cursor("web-0", time.Date(2026, 9, 9, 7, 0, 0, 0, time.UTC)))
	})

	require.Contains(t, body, "id:-\nevent:replay\n", "the replay frame left the browser's old cursor standing — got: %s", body)
}

// maxPodsInTest is one past the cursor's pod bound, which the contract fixes
// at 8.
const maxPodsInTest = 9

// `-` is an id the stream hands out, so a caller sending it back as `?since=`
// — as the docs say to do with the last id — gets a fresh start with a
// `replay` frame, not a 400, on either view.
func TestStreamReleaseLogs_ThePlaceholderIdIsAcceptedAsSince(t *testing.T) {
	at := time.Date(2026, 9, 9, 7, 36, 36, 0, time.UTC)
	for name, query := range map[string]string{
		"all":            "?since=-",
		"named instance": "?instance=web-1&since=-",
	} {
		t.Run(name, func(t *testing.T) {
			applier := &fakeK8sApplier{
				instances: []k8s.Instance{{Name: "web-1"}},
				logLines:  []string{"from the top"},
				logLineAt: at,
			}

			body := resumeReleaseAt(t, applier, query, func(r *http.Request) {
				// An explicit since wins over the header, placeholder or not.
				r.Header.Set("Last-Event-ID", cursor("web-1", at.Add(time.Hour)))
			})

			require.Nil(t, applier.sinceSeen)
			require.Contains(t, body, "event:replay")
			require.Contains(t, body, "from the top")
		})
	}
}

// `replay` is only for a resume point that was sent and not applied. A first
// open and a resume that worked say nothing, or a client would throw away the
// very lines the resume kept.
func TestStreamReleaseLogs_NoReplayFrameWhenNothingIsIgnored(t *testing.T) {
	at := time.Date(2026, 9, 9, 7, 40, 0, 0, time.UTC)
	for name, tweak := range map[string]func(*http.Request){
		"first open": func(*http.Request) {},
		"applied cursor": func(r *http.Request) {
			r.Header.Set("Last-Event-ID", cursor("web-1", at))
		},
	} {
		t.Run(name, func(t *testing.T) {
			applier := &fakeK8sApplier{
				instances: []k8s.Instance{{Name: "web-1"}},
				logLines:  []string{"x"},
				logLineAt: at.Add(time.Minute),
			}

			body := resumeRelease(t, applier, tweak)

			require.NotContains(t, body, "event:replay")
		})
	}
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

// Naming an instance resumes from one instant. The name is in the URL, so it
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
// leaving a dead log pane the reader cannot revive without reloading. It does
// happen for real: a reader who switches from `all` to one instance carries an
// `all` cursor (#172) into a stream that takes a single instant.
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
	require.Contains(t, body, "event:replay",
		"the stream started over without saying so, and the pane kept what it already had")
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

// ...and so is anything in `?since=` on `all` that is not a cursor.
func TestStreamReleaseLogs_AnUnreadableCursorInSinceIsRefused(t *testing.T) {
	applier := &fakeK8sApplier{instances: []k8s.Instance{{Name: "web-1"}}}

	rec := refusedAt(t, applier, "?since=web-1@yesterday")

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
