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

	// writeError(c, <500 or 502 or an upstream status>, "...", <anything with err>)
	//
	// 502 is in scope because #49 originally stopped at 500 and the same
	// apiserver address went straight out the next status code over;
	// resp.StatusCode is in scope because it can be a 5xx echoed from upstream
	// along with its body.
	raw := regexp.MustCompile(
		`writeError\([^,]+,\s*(http\.StatusInternalServerError|http\.StatusBadGateway|resp\.StatusCode)\s*,[^,]+,[^)]*\b(err|body)\b[^)]*\)`)

	var offenders []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		// errors.go is where internalError and upstreamError live; they are the
		// sanctioned way to write these responses.
		if name == "errors.go" {
			continue
		}
		src, err := os.ReadFile(filepath.Join(".", name))
		require.NoError(t, err)
		for i, line := range strings.Split(string(src), "\n") {
			// A deliberate pass-through carries `raw-ok:` and a reason, so the
			// exception is visible in review rather than hidden in this regex.
			if raw.MatchString(line) && !strings.Contains(line, "raw-ok:") {
				offenders = append(offenders, name+":"+itoa(i+1)+" "+strings.TrimSpace(line))
			}
		}
	}
	require.Empty(t, offenders,
		"5xx responses must not carry the error text — use internalError/upstreamError, which log it instead; "+
			"a deliberate pass-through needs a `// raw-ok: <reason>` comment on the line")
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
