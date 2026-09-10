package api_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

// The `time` on a log frame used to be the server's own clock, read at the
// moment it forwarded the line. That is not when anything happened. Opening a
// pod's logs replays its history, so every line of a startup 16 minutes ago
// arrived stamped "now" — 22 lines all on the same second, while the lines
// themselves said 07:36:36 (#131). Whatever the pane is for, it is not that.
func TestStreamReleaseLogs_UsesTheContainersClockNotOurs(t *testing.T) {
	wrote := time.Date(2026, 9, 9, 7, 36, 36, 123_000_000, time.UTC)
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logLines:  []string{"using the epoll event method"},
		logLineAt: wrote,
	}

	events := sseEvents(t, streamingRelease(t, applier))

	var frame map[string]any
	require.NoError(t, json.Unmarshal([]byte(events[0][1]), &frame), "got: %v", events)
	require.Equal(t, "log", events[0][0])
	require.Equal(t, float64(wrote.UnixMilli()), frame["time"],
		"the frame carried a time that is not when the container wrote the line")
}

// A line the kubelet could not stamp still has to render. The pane draws one
// timestamp per row, so "no time" is not an option it has — and a missing value
// reads as a rendering fault rather than as missing data.
func TestStreamReleaseLogs_FallsBackToNowForAnUnstampedLine(t *testing.T) {
	applier := &fakeK8sApplier{
		instances: []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logLines:  []string{"a line with no kubelet stamp"},
		// logLineAt left zero.
	}

	before := time.Now().UnixMilli()
	events := sseEvents(t, streamingRelease(t, applier))
	after := time.Now().UnixMilli()

	var frame map[string]any
	require.NoError(t, json.Unmarshal([]byte(events[0][1]), &frame), "got: %v", events)
	got := int64(frame["time"].(float64))
	require.GreaterOrEqual(t, got, before)
	require.LessOrEqual(t, got, after)
}
