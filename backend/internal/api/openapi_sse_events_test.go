package api_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The frame table in streamReleaseLogs' description is the only place a client
// learns which event names it has to handle, and until now nothing held the two
// together.
//
// The ErrorKind axis is guarded: openapi_spec_test.go reads the kinds out of
// writeError/sseError calls and compares them against the enum, and #82 widened
// that regex to cover the in-stream frame for exactly this reason. The event
// *name* axis had no equivalent, which did not matter while `error` was the
// only named frame anyone reasoned about. #162 added `end` — a frame that is
// not an ErrorKind and that a client must act on — so the axis now carries
// meaning and needs the same treatment.
//
// Without this, renaming `end` to `done`, adding a frame, or dropping one
// leaves every backend test green while the spec quietly becomes false, and the
// first person to notice is someone writing a client against it.

var sseEventCall = regexp.MustCompile(`SSEvent\(\s*"([a-z0-9-]+)"`)

// sseEventsEmitted reads the names straight out of the c.SSEvent calls, so the
// comparison is against what the server actually sends rather than a second
// hand-maintained list.
func sseEventsEmitted(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	seen := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		for _, m := range sseEventCall.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]] = true
		}
	}
	require.NotEmpty(t, seen, "found no c.SSEvent calls — the regex has stopped matching")
	return sortedKeys(seen)
}

// sseEventsDocumented pulls the names out of the frame table's first column.
//
// Scoped to the one table rather than to every `| `x` |` row in the file: the
// description also carries a table keyed by ErrorKind, and matching that too
// made this guard demand that `k8s-error` be an event name. The anchor is the
// header row, and the table ends at the first line that is not a row.
func sseEventsDocumented(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(specPath)
	require.NoError(t, err)

	lines := strings.Split(string(raw), "\n")
	start := -1
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "| event | data |") {
			start = i
			break
		}
	}
	require.NotEqual(t, -1, start,
		"the SSE frame table is gone from %s — if its shape changed, this guard has to change with it", specPath)

	row := regexp.MustCompile("^\\|\\s*`([a-z0-9-]+)`\\s*\\|")
	seen := map[string]bool{}
	for _, l := range lines[start+1:] {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "|") {
			break
		}
		if m := row.FindStringSubmatch(l); m != nil {
			seen[m[1]] = true
		}
	}
	require.NotEmpty(t, seen, "found no frame-table rows in %s", specPath)
	return sortedKeys(seen)
}

func TestOpenAPISpec_DocumentsEverySSEEventType(t *testing.T) {
	documented := map[string]bool{}
	for _, n := range sseEventsDocumented(t) {
		documented[n] = true
	}

	var missing []string
	for _, name := range sseEventsEmitted(t) {
		if !documented[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	require.Empty(t, missing,
		"the server sends these SSE frames but %s does not list them — a client cannot handle a frame it was never told about", specPath)
}

func TestOpenAPISpec_DocumentsNoSSEEventThatIsGone(t *testing.T) {
	emitted := map[string]bool{}
	for _, n := range sseEventsEmitted(t) {
		emitted[n] = true
	}

	var stale []string
	for _, name := range sseEventsDocumented(t) {
		if !emitted[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	require.Empty(t, stale,
		"%s documents SSE frames the server no longer sends — a client would write a branch that never runs", specPath)
}
