package api_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

// The stream ends when every pod has stopped emitting, and it used to end in
// silence: the server simply closed the connection. WHATWG gives EventSource no
// way to tell that from a dropped one, so the browser reopened three seconds
// later and — with no SinceTime (#107) — replayed the whole container log. A
// browser-initiated reconnect does not empty the pane either (only the
// Reconnect button remounts it), so the same lines piled up until they filled
// LINE_CAP and pushed the real scrollback out. A finished Job's pod is enough
// to trigger it, and the demo has one (#162).
//
// The server is the only party that knows, so one frame is the whole fix.
func TestStreamReleaseLogs_AnnouncesTheEndOfTheStream(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logLines:  []string{"first", "last"},
	}

	events := sseEvents(t, streamingRelease(t, applier))

	require.NotEmpty(t, events, "expected at least the end frame")
	require.Equal(t, "end", events[len(events)-1][0],
		"the last frame must say the stream is over, got: %v", events)
	// The log lines still have to arrive; the end frame is an addition, not a
	// replacement for the stream doing its job.
	require.Equal(t, "log", events[0][0], "got: %v", events)
}

// An error frame is not the end — with ?instance=all the handler keeps
// following the healthy pods after writing one (openapi.yaml says so). So the
// end frame has to come after the error too, or a stream that lost one pod
// still leaves the client unable to tell "over" from "dropped".
func TestStreamReleaseLogs_AnnouncesTheEndAfterAnError(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	events := sseEvents(t, streamingRelease(t, applier))

	require.Equal(t, "end", events[len(events)-1][0],
		"expected the end frame after the error frame, got: %v", events)
	require.Equal(t, "error", events[len(events)-2][0],
		"the error must still be delivered before the end, got: %v", events)
}

// The frame carries no cluster detail. Everything else on this endpoint is
// careful about that (#108) and a new frame is a new chance to leak.
func TestStreamReleaseLogs_EndFrameCarriesNoClusterDetail(t *testing.T) {
	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}

	events := sseEvents(t, streamingRelease(t, applier))
	end := events[len(events)-1]

	require.Equal(t, "end", end[0])
	for _, leak := range []string{"10.43.0.1", "6443", "web-7d9f8-x2k4l", "connection refused"} {
		require.NotContains(t, end[1], leak, "the end frame exposed %q", leak)
	}
}
