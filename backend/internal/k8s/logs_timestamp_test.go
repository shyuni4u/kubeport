package k8s

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// PodLogOptions.Timestamps puts an RFC3339Nano stamp and a space in front of
// every line. Reading it is what gives the log pane a time axis: until now the
// server stamped each line with its own clock at the moment it read it, so a
// stream opened 16 minutes after a pod started showed all of that pod's history
// as having happened just now (#131).
func TestSplitTimestamp(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
		at   string // RFC3339Nano, or "" for "no usable stamp"
		text string
	}{
		{
			name: "an ordinary line",
			line: "2026-09-09T07:36:36.123456789Z hello world",
			at:   "2026-09-09T07:36:36.123456789Z",
			text: "hello world",
		},
		{
			// The case from the issue. nginx writes its own date, so the line
			// carries two — only the first one is kubelet's.
			name: "a line that starts with its own date",
			line: `2026-09-09T07:36:36.123456789Z 2026/09/09 07:36:36 [notice] 1#1: nginx/1.27.5`,
			at:   "2026-09-09T07:36:36.123456789Z",
			text: `2026/09/09 07:36:36 [notice] 1#1: nginx/1.27.5`,
		},
		{
			name: "whole seconds, no fraction",
			line: "2026-09-09T07:36:36Z ready",
			at:   "2026-09-09T07:36:36Z",
			text: "ready",
		},
		{
			name: "an offset rather than Z",
			line: "2026-09-09T16:36:36.5+09:00 ready",
			at:   "2026-09-09T16:36:36.5+09:00",
			text: "ready",
		},
		{
			// A container that prints an empty line still gets a stamp.
			name: "an empty line keeps its time",
			line: "2026-09-09T07:36:36.1Z ",
			at:   "2026-09-09T07:36:36.1Z",
			text: "",
		},
		{
			name: "a stamp with nothing after it at all",
			line: "2026-09-09T07:36:36.1Z",
			at:   "2026-09-09T07:36:36.1Z",
			text: "",
		},
		{
			// Not supposed to happen with Timestamps: true, but a line the
			// kubelet could not stamp must survive rather than lose its head.
			name: "no stamp at all",
			line: "plain line with no timestamp",
			at:   "",
			text: "plain line with no timestamp",
		},
		{
			name: "something that is not a time in the first field",
			line: "2026-99-99T99:99:99Z broken",
			at:   "",
			text: "2026-99-99T99:99:99Z broken",
		},
		{
			name: "empty input",
			line: "",
			at:   "",
			text: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at, text := splitTimestamp(tc.line)

			require.Equal(t, tc.text, text)
			if tc.at == "" {
				require.True(t, at.IsZero(), "expected no usable time, got %s", at)
				return
			}
			want, err := time.Parse(time.RFC3339Nano, tc.at)
			require.NoError(t, err)
			require.True(t, at.Equal(want), "want %s, got %s", want, at)
		})
	}
}
