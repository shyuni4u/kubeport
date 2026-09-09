package api_test

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// captureLog redirects the standard logger for the duration of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	out, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(out)
		log.SetFlags(flags)
	})
	return &buf
}

// A refused request used to leave no trace: writeError only writes the
// response, and gin.Recovery() was the router's only middleware. Issue #72.
func TestAccessLog_RecordsWhoAndWhat(t *testing.T) {
	buf := captureLog(t)
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	w := do(t, r, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code)

	line := buf.String()
	require.Contains(t, line, "access ")
	require.Contains(t, line, "method=GET")
	require.Contains(t, line, "path=/v1/templates")
	require.Contains(t, line, "status=200")
	require.Contains(t, line, "user=admin@example.com")
}

// The point of the whole thing: a denial is recorded, with the identity.
func TestAccessLog_RecordsADenial(t *testing.T) {
	buf := captureLog(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:        demoVerifier{email: "demo-admin@" + demoDomain},
		Store:           testStore(t),
		DemoEmailDomain: demoDomain,
	})

	body, _ := json.Marshal(map[string]any{"name": "x", "display_name": "x", "authoring_mode": "yaml"})
	w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code)

	line := buf.String()
	require.Contains(t, line, "status=403")
	require.Contains(t, line, "user=demo-admin@"+demoDomain)
}

// Never log the credential.
func TestAccessLog_DoesNotLogTheBearerToken(t *testing.T) {
	buf := captureLog(t)
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	do(t, r, http.MethodGet, "/v1/templates", nil)
	// do() sends "Authorization: Bearer x".
	require.NotContains(t, buf.String(), "Bearer")
}

// An unmatched path is attacker-controlled, so it is quoted — a newline in it
// must not be able to forge a second log line.
func TestAccessLog_QuotesAnUnmatchedPath(t *testing.T) {
	buf := captureLog(t)
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	do(t, r, http.MethodGet, "/v1/no-such-route%0Aaccess%20id=forged", nil)
	line := buf.String()
	require.Contains(t, line, `path="`)
	require.NotContains(t, line, "\naccess id=forged")
}

// The id in the response body is the id in the log, so a user can quote it and
// an operator can find the request.
func TestRequestID_TiesTheResponseToTheLog(t *testing.T) {
	buf := captureLog(t)
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	w := do(t, r, http.MethodGet, "/v1/templates/no-such-template-"+randSuffix(), nil)
	require.Equal(t, http.StatusNotFound, w.Code)

	var p struct {
		RequestID string `json:"request_id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.NotEmpty(t, p.RequestID, "Problem.request_id was declared but never populated")
	require.Equal(t, p.RequestID, w.Header().Get("X-Request-Id"))
	require.Contains(t, buf.String(), "id="+p.RequestID)
}

// An inbound id is kept so a trace survives the BFF hop, but a huge one is not
// copied into every log line.
func TestRequestID_HonoursInboundHeaderWithinReason(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})

	req := newAuthedRequest(http.MethodGet, "/v1/templates")
	req.Header.Set("X-Request-Id", "from-the-ingress")
	w := serve(r, req)
	require.Equal(t, "from-the-ingress", w.Header().Get("X-Request-Id"))

	req = newAuthedRequest(http.MethodGet, "/v1/templates")
	req.Header.Set("X-Request-Id", strings.Repeat("a", 200))
	w = serve(r, req)
	require.NotEqual(t, strings.Repeat("a", 200), w.Header().Get("X-Request-Id"))
	require.NotEmpty(t, w.Header().Get("X-Request-Id"))
}
