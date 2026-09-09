package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

func readSourceFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	require.NoError(t, err)
	return string(b)
}

// Every /v1 error body is a Problem. A client that switches on `title` must
// not have to special-case one endpoint, so the 401 kind is spelled
// "unauthenticated" everywhere (#56) — release_logs.go used "unauthorized".
func TestErrorBodies_UseOneUnauthenticatedKind(t *testing.T) {
	r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})

	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil) // no Authorization
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)

	var p struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Detail string `json:"detail"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &p))
	require.Equal(t, "unauthenticated", p.Title)
	require.Equal(t, "https://kubeport.io/errors/unauthenticated", p.Type)
	require.Equal(t, 401, p.Status)
	require.NotEmpty(t, p.Detail)
}

// Guard against the string coming back. grep is the honest test here: the
// release-logs 401 needs a live release plus a reachable cluster to reach
// through a request, which this package cannot set up.
func TestErrorKinds_NoUnauthorizedSpelling(t *testing.T) {
	found := strings.Contains(readSourceFile(t, "release_logs.go"), `"unauthorized"`)
	require.False(t, found,
		`release_logs.go still spells the 401 kind "unauthorized"; use "unauthenticated" so /v1 has one 401 kind (#56)`)
}
