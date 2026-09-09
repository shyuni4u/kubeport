package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// A pgx connect failure reads
// "failed to connect to `host=... user=... database=...`", and a k8s dial
// failure carries the apiserver's internal address. Handing either to the
// client tells any authenticated caller — including a demo visitor whose
// password is on the landing page — about infrastructure they cannot reach.
// Issue #49.
func TestInternalError_KeepsTheDetailOutOfTheResponse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/templates", nil)

	internalError(c, "ListTemplates",
		errors.New("failed to connect to `host=10.0.0.5 user=kubeport database=kubeport`"))

	require.Equal(t, http.StatusInternalServerError, w.Code)
	body := w.Body.String()
	require.NotContains(t, body, "10.0.0.5")
	require.NotContains(t, body, "user=kubeport")
	require.Contains(t, body, `"internal"`)
	// Still says which operation failed, so a bug report is actionable.
	require.Contains(t, body, "ListTemplates")
}

// The guard that keeps this from creeping back: 500s must not interpolate an
// error. 4xx are deliberately excluded — a validation message is the point of
// the response there, and the k8s authorizer's "Forbidden: ..." text is what
// tells a user why their deploy was refused.
func TestNoRawErrorsIn500Responses(t *testing.T) {
	entries, err := os.ReadDir(".")
	require.NoError(t, err)

	// writeError(c, http.StatusInternalServerError, "...", <anything with err>)
	raw := regexp.MustCompile(`writeError\([^,]+,\s*http\.StatusInternalServerError\s*,[^,]+,[^)]*\berr\b[^)]*\)`)

	var offenders []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(filepath.Join(".", name))
		require.NoError(t, err)
		for i, line := range strings.Split(string(src), "\n") {
			if raw.MatchString(line) {
				offenders = append(offenders, name+":"+itoa(i+1)+" "+strings.TrimSpace(line))
			}
		}
	}
	require.Empty(t, offenders,
		"500 responses must not carry the error text — use internalError(c, op, err), which logs it instead")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
