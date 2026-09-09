package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
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
// The set of error kinds /v1 is allowed to emit. This is an allowlist rather
// than a blacklist of known-bad spellings: the original bug was one handler
// inventing "unauthorized" alongside "unauthenticated", and only an allowlist
// catches the next handler that invents something. When a genuinely new kind
// is needed, add it here and to the API docs in the same change.
var allowedErrorKinds = map[string]bool{
	"unauthenticated":  true,
	"rbac-denied":      true,
	"demo-restricted":  true,
	"validation-error": true,
	"not-found":        true,
	"user-not-found":   true,
	"no-pods":          true,
	"conflict":         true,
	"k8s-error":        true,
	"cluster-config":   true,
	// 405 from the router's own NoMethod fallback (#81). Gin folded a wrong
	// verb into its 404, and an agent reading "not found" concludes the
	// resource is gone rather than that it used the wrong method.
	"method-not-allowed": true,
	// 502 when the *cluster* rejects the token kubeport forwarded, as opposed
	// to kubeport rejecting the session (#83). Separate from k8s-error because
	// the right client response differs: signing in again fixes the second
	// kind of 401 and never fixes this one.
	"cluster-auth-denied": true,
	// 429 from the SSAR proxy's per-caller budget (#73). Distinct from
	// rbac-denied on purpose: the caller is allowed, just too fast, and the
	// right client response is to back off rather than to give up.
	"rate-limited": true,
	"internal":     true,
}

func TestErrorKinds_AllowlistOnly(t *testing.T) {
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)

	re := regexp.MustCompile(`writeError\([^,]+,\s*[^,]+,\s*"([a-z0-9-]+)"`)
	var checked int
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		for _, m := range re.FindAllStringSubmatch(readSourceFile(t, f), -1) {
			checked++
			require.True(t, allowedErrorKinds[m[1]],
				"%s: error kind %q is not in allowedErrorKinds — add it here and document it, "+
					"or reuse an existing kind so clients can keep one branch per kind (#56)", f, m[1])
		}
	}
	require.Greater(t, checked, 50, "regex stopped matching writeError calls; fix the pattern")
}
