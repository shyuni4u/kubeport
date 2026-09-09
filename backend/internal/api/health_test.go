package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func healthBody(t *testing.T, h gin.HandlerFunc, target string) map[string]any {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/healthz", h)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
	require.Equal(t, http.StatusOK, w.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	return body
}

// The kubelet probes hit the bare path every 10 and 20 seconds. They must stay
// a constant — no database, no catalog key to parse.
func TestHealthz_BarePathStaysAConstant(t *testing.T) {
	body := healthBody(t, healthz(Deps{}, &catalogGauge{}), "/healthz")

	require.Equal(t, map[string]any{"status": "ok"}, body)
}

// #119: without a store the endpoint must still answer, so a misconfigured
// deployment degrades the signal rather than the readiness probe.
func TestHealthz_VerboseWithoutStoreOmitsCatalog(t *testing.T) {
	body := healthBody(t, healthz(Deps{HealthPublicCatalog: true}, &catalogGauge{}), "/healthz?verbose=1")

	require.Equal(t, "ok", body["status"])
	require.NotContains(t, body, "catalog")
}

// /healthz is unauthenticated, so the catalog size is opt-in: a self-hosted
// install must not disclose it to anonymous callers. Deps{} is the default.
func TestHealthz_CatalogIsWithheldUnlessOptedIn(t *testing.T) {
	body := healthBody(t, healthz(Deps{}, &catalogGauge{}), "/healthz?verbose=1")

	require.Equal(t, map[string]any{"status": "ok"}, body)
	require.NotContains(t, body, "catalog")
}

// Anything other than verbose=1 is the cheap path — guards against a typo in
// the cron quietly turning the probe into a database query on every hit.
func TestHealthz_OnlyVerboseOneOptsIn(t *testing.T) {
	for _, q := range []string{"/healthz?verbose=0", "/healthz?verbose=true", "/healthz?verbose=", "/healthz?v=1"} {
		t.Run(q, func(t *testing.T) {
			body := healthBody(t, healthz(Deps{}, &catalogGauge{}), q)

			require.Equal(t, map[string]any{"status": "ok"}, body)
		})
	}
}
