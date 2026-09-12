package api

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #172 — the `instance=all` cursor round-trips, in one fixed shape whatever
// zone or precision the kubelet's stamps came in.
func TestLogCursor_RoundTripsInOneFixedShape(t *testing.T) {
	pos := map[string]time.Time{
		"web-2": time.Date(2026, 9, 9, 7, 35, 0, 900_000_000, time.UTC),
		"web-1": time.Date(2026, 9, 9, 16, 36, 36, 100_000_000, time.FixedZone("KST", 9*60*60)),
	}

	s := formatLogCursor(pos)

	require.Equal(t,
		"web-1@2026-09-09T07:36:36.100000000Z,web-2@2026-09-09T07:35:00.900000000Z", s,
		"sorted by pod, UTC, nine fractional digits")
	back, ok := parseLogCursor(s)
	require.True(t, ok)
	require.Len(t, back, len(pos))
	for p, at := range pos {
		require.True(t, back[p].Equal(at), "pod %s: want %s, got %s", p, at, back[p])
	}
}

// Anything not in that shape is refused, so the handler can tell a cursor from
// a single-instance id, a typo, or a header someone rewrote.
func TestLogCursor_RefusesWhatIsNotACursor(t *testing.T) {
	for name, s := range map[string]string{
		"empty":                          "",
		"a single-instance id":           "2026-09-09T07:36:36.000000000Z",
		"no time":                        "web-1@",
		"no pod":                         "@2026-09-09T07:36:36Z",
		"a time that is not one":         "web-1@yesterday",
		"a name Kubernetes would refuse": "Web_1@2026-09-09T07:36:36Z",
		"the same pod twice":             "web-1@2026-09-09T07:36:36Z,web-1@2026-09-09T07:37:00Z",
		"a trailing comma":               "web-1@2026-09-09T07:36:36Z,",
	} {
		t.Run(name, func(t *testing.T) {
			_, ok := parseLogCursor(s)
			require.False(t, ok, "accepted %q", s)
		})
	}
}

// More pods than the cursor covers is not a cursor this server hands out.
func TestLogCursor_RefusesMorePodsThanItCovers(t *testing.T) {
	items := make([]string, maxCursorPods+1)
	for i := range items {
		items[i] = fmt.Sprintf("web-%d@2026-09-09T07:36:36Z", i)
	}
	_, ok := parseLogCursor(strings.Join(items, ","))
	require.False(t, ok)

	_, ok = parseLogCursor(strings.Join(items[:maxCursorPods], ","))
	require.True(t, ok, "exactly maxCursorPods must still be accepted")
}
