package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/k8s"
)

// Withholding a reason from the response is only safe if the reason is
// findable, and `request_id` is the whole of that promise — openapi.yaml and
// docs/machine-clients.md both tell a caller to quote it. The access log
// cannot keep the promise on its own: it is written when the request *ends*
// and it records `c.FullPath()`, the route pattern rather than the path, so
// `/v1/releases/:id/logs` names no release. For a stream that stays open for
// minutes while others start and finish there is nothing to join on.
//
// So the line carrying the reason has to carry the id too.

// captureLog lives in accesslog_test.go — the same redirect, for the same
// reason.

// logLineWithID returns the captured line carrying `id=<want>` and `needle`.
func logLineWithID(t *testing.T, buf *bytes.Buffer, id, needle string) string {
	t.Helper()
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "id="+id) && strings.Contains(line, needle) {
			return line
		}
	}
	t.Fatalf("no log line carries both id=%s and %q.\ncaptured:\n%s", id, needle, buf.String())
	return ""
}

var requestIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// A 500 is the case where the response says least, so it is the one that most
// needs the log to say more (#49).
func TestInternalError_LogsTheReasonUnderTheCallersRequestID(t *testing.T) {
	r, _, factory := newSSARRouter(t)
	cluster := seedCluster(t, r)

	// Capture only after the seeding above, so the buffer holds this request.
	buf := captureLog(t)
	factory.err = errors.New("caBundle parse failure: x509 for 10.0.4.7:6443")

	body, _ := json.Marshal(map[string]any{
		"cluster": cluster, "namespace": "default",
		"verb": "create", "group": "apps", "resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.Equal(t, http.StatusInternalServerError, w.Code, "body: %s", w.Body.String())

	var p map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	id, _ := p["request_id"].(string)
	require.True(t, requestIDRe.MatchString(id), "request_id %q", id)
	require.NotContains(t, w.Body.String(), "caBundle parse failure",
		"the 500 body must not carry the reason")

	line := logLineWithID(t, buf, id, "CheckSelfSubjectAccess")
	require.Contains(t, line, "caBundle parse failure",
		"the log line under the caller's id must carry the reason the body withheld")
}

// The stream is the case Codex caught: the response frame says almost nothing,
// and the access log lands after the stream closes with only the route pattern
// on it.
func TestSSEError_LogsTheReasonUnderTheFramesRequestID(t *testing.T) {
	buf := captureLog(t)

	applier := &fakeK8sApplier{
		instances:    []k8s.Instance{{Name: "web-7d9f8-x2k4l"}},
		logStreamErr: streamErr,
	}
	events := sseEvents(t, streamingRelease(t, applier))

	var frame string
	for _, e := range events {
		if e[0] == "error" {
			frame = e[1]
		}
	}
	require.NotEmpty(t, frame, "expected an SSE error frame, got: %v", events)

	var p map[string]any
	require.NoError(t, json.Unmarshal([]byte(frame), &p))
	id, _ := p["request_id"].(string)
	require.True(t, requestIDRe.MatchString(id), "request_id %q", id)

	line := logLineWithID(t, buf, id, "StreamReleaseLogs")
	require.Contains(t, line, "connection refused",
		"the log line under the frame's id must carry the reason the frame withheld")
	require.Contains(t, line, "web-7d9f8-x2k4l",
		"and the pod, which the frame also withholds")
}
