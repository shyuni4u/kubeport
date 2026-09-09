package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// A typo'd path and a wrong method are the two ways a machine client meets the
// API without meeting a handler. Gin answers both with a text/plain body by
// default, so the one shape #79 established for /v1 had two holes in it
// (issue #81). These are the only responses in the service that no handler
// produces, which is exactly why nothing was checking them.

func decodeProblem(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	require.True(t,
		strings.HasPrefix(w.Header().Get("Content-Type"), "application/json"),
		"expected a JSON Problem, got Content-Type %q with body %q",
		w.Header().Get("Content-Type"), w.Body.String())

	var p map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p), "body: %s", w.Body.String())
	return p
}

func TestUnknownPathReturnsProblem(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/templatez", nil))

	require.Equal(t, http.StatusNotFound, w.Code)
	p := decodeProblem(t, w)
	require.Equal(t, "not-found", p["title"])
	require.Equal(t, float64(http.StatusNotFound), p["status"])
	require.NotEmpty(t, p["request_id"], "a 404 is still a request worth correlating")
}

// The router must distinguish "no such resource" from "wrong verb". Gin folds
// the second into the first unless HandleMethodNotAllowed is on, and an agent
// reading 404 concludes the resource is gone and stops retrying.
func TestWrongMethodReturns405NotAProblem404(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/healthz", nil))

	require.Equal(t, http.StatusMethodNotAllowed, w.Code)
	p := decodeProblem(t, w)
	require.Equal(t, "method-not-allowed", p["title"])
	require.Equal(t, float64(http.StatusMethodNotAllowed), p["status"])
}

// Neither fallback runs a handler, so neither can echo a caller-controlled
// path back into the body. #72 closed the same shape of hole in the access
// log; a reflected 404 would have reopened it one layer up.
func TestFallbacksDoNotEchoTheRequestPath(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{})

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/v1/%3Cscript%3Ealert(1)%3C/script%3E"},
		{http.MethodDelete, "/healthz"},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		require.NotContains(t, w.Body.String(), "script",
			"%s %s echoed the request path into the response", tc.method, tc.path)
	}
}

// The fallbacks sit outside /v1 but must still carry the correlation header
// the rest of the API sets, or a client cannot report them.
func TestFallbacksCarryRequestID(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/nope", nil))
	require.NotEmpty(t, w.Header().Get("X-Request-Id"))
}
