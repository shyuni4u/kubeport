package api

import (
	"sort"
	"strings"
	"time"
)

// maxCursorPods bounds how many pods an `instance=all` stream keeps resume
// positions for (#172). The cursor rides on every log frame as its SSE id, so it
// grows with the pod count on every line: eight pods with 63-character names
// come to about 760 bytes a frame, where a release usually runs one to three.
// Past the bound the stream's ids are noCursorID and a reconnect replays from
// the beginning, as every `all` stream did before — a cost in bandwidth, never
// a gap.
const maxCursorPods = 8

// noCursorID is the id of a `replay` frame and of a stamped log frame on an
// `all` stream past maxCursorPods. It is deliberately not a cursor or an
// instant, so handing it back — as Last-Event-ID or as `?since=` — starts the
// stream over (with a `replay` frame) instead of resuming from an older point
// the browser would otherwise still hold.
const noCursorID = "-"

// maxPodNameLen is Kubernetes' own limit on an object name.
const maxPodNameLen = 253

// maxCursorLen is the longest cursor parseLogCursor can accept: maxCursorPods
// items of a longest name, `@`, the longest RFC3339 time (nine fractional
// digits and an offset, which a hand-written `?since=` may carry) and a
// separating comma.
const maxCursorLen = maxCursorPods * (maxPodNameLen + 1 + len(time.RFC3339Nano) + 1)

// formatLogCursor renders per-pod positions as an `instance=all` resume point:
// `pod@time` pairs sorted by pod and joined with commas, each time in the same
// fixed UTC, nine-fractional-digit form a single-instance id uses. Sorted so
// the same positions always make the same string.
func formatLogCursor(pos map[string]time.Time) string {
	pods := make([]string, 0, len(pos))
	for p := range pos {
		pods = append(pods, p)
	}
	sort.Strings(pods)
	var b strings.Builder
	for i, p := range pods {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(p)
		b.WriteByte('@')
		b.WriteString(pos[p].UTC().Format(resumeIDLayout))
	}
	return b.String()
}

// parseLogCursor reads a resume point in formatLogCursor's shape. It reports
// false for anything else — a single-instance id among them, which has no `@` —
// and leaves what that means to the caller: a `?since=` the caller wrote is
// refused, a `Last-Event-ID` nobody wrote starts the stream over.
//
// Pod names are held to what Kubernetes allows in one (lowercase letters,
// digits, `-` and `.`), which is also what keeps `@` and `,` unambiguous as
// separators.
func parseLogCursor(s string) (map[string]time.Time, bool) {
	if s == "" {
		return nil, false
	}
	// Bounded before anything is allocated per item: the value is a header or a
	// query string the caller controls, and splitting all of it first would let
	// one request of commas cost a slice far larger than any cursor we hand out.
	if len(s) > maxCursorLen {
		return nil, false
	}
	items := strings.SplitN(s, ",", maxCursorPods+1)
	if len(items) > maxCursorPods {
		return nil, false
	}
	out := make(map[string]time.Time, len(items))
	for _, item := range items {
		pod, stamp, ok := strings.Cut(item, "@")
		if !ok || !validPodName(pod) {
			return nil, false
		}
		if _, dup := out[pod]; dup {
			return nil, false
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return nil, false
		}
		out[pod] = at
	}
	return out, true
}

func validPodName(s string) bool {
	if s == "" || len(s) > maxPodNameLen {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}
