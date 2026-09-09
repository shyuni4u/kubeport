package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// Each call builds a fresh router, and therefore a fresh gauge: the count is
// cached for 30s, so re-reading through one router would return the first
// answer and the deltas below would all be zero.
func healthCatalogCount(t *testing.T, s *store.Store) float64 {
	t.Helper()
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:            adminVerifier{},
		Store:               s,
		DemoEmailDomain:     demoDomain,
		HealthPublicCatalog: true,
	})
	w := do(t, r, http.MethodGet, "/healthz?verbose=1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Status  string `json:"status"`
		Catalog struct {
			Available bool    `json:"available"`
			Templates float64 `json:"templates"`
		} `json:"catalog"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "ok", body.Status)
	require.True(t, body.Catalog.Available, "catalog should be readable: %s", w.Body.String())
	return body.Catalog.Templates
}

// Opting the count in without a demo domain leaves nothing to scope it to, so
// the number would be the size of the operator's own catalog — the exact
// disclosure the default-off flag exists to prevent. The chart happens to
// prevent this by nesting the env inside demo.enabled; this is the code
// keeping its own promise.
func TestHealthzCatalog_WithoutDemoDomainNothingIsPublished(t *testing.T) {
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:            adminVerifier{},
		Store:               s,
		HealthPublicCatalog: true,
		// DemoEmailDomain deliberately empty.
	})

	w := do(t, r, http.MethodGet, "/healthz?verbose=1", nil)

	require.Equal(t, http.StatusOK, w.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "ok", body["status"], "a misconfigured flag is not an outage")
	require.NotContains(t, body, "catalog")
}

// A caller who hangs up must not poison the shared cache: the value belongs to
// the process, not to the first request that filled it. Filling it from a
// request context made a cancelled request cache `degraded` for the whole TTL,
// which would have kept the uptime alarm red and hidden the empty-catalog case
// the alarm exists for.
func TestHealthzCatalog_CancelledRequestDoesNotPoisonTheCache(t *testing.T) {
	s := testStore(t)
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:            adminVerifier{},
		Store:               s,
		DemoEmailDomain:     demoDomain,
		HealthPublicCatalog: true,
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/healthz?verbose=1", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	// Whatever that request got, the next one must be answered from a healthy
	// query rather than a cached cancellation.
	w2 := do(t, r, http.MethodGet, "/healthz?verbose=1", nil)
	require.Equal(t, http.StatusOK, w2.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(w2.Body.Bytes(), &body))
	require.Equal(t, "ok", body["status"], "body: %s", w2.Body.String())
	catalog, ok := body["catalog"].(map[string]any)
	require.True(t, ok, "body: %s", w2.Body.String())
	require.Equal(t, true, catalog["available"])
}

// The signal exists to catch a reset that wiped the demo catalog and failed to
// re-seed. An operator's own templates are invisible to demo visitors
// (scopeTemplatesToDemo), so counting every row would let them mask exactly
// that state — the monitor would report healthy while visitors saw an empty
// catalog.
//
// Deltas rather than absolute counts: the package shares one database and
// other tests leave published templates behind.
func TestHealthzCatalog_OperatorTemplatesDoNotMaskAnEmptyDemo(t *testing.T) {
	s := testStore(t)
	before := healthCatalogCount(t, s)

	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, DemoEmailDomain: demoDomain,
	})
	seedPublishedTemplate(t, adminRouter) // non-demo owner

	require.Equal(t, before, healthCatalogCount(t, s),
		"a template only the operator can see must not count towards the demo catalog")
}

func TestHealthzCatalog_CountsDemoOwnedPublishedTemplates(t *testing.T) {
	s := testStore(t)
	before := healthCatalogCount(t, s)

	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)
	name := "demo-authored-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(name)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	// Still a draft at this point — nothing a visitor can deploy, so nothing
	// that should reassure the monitor.
	require.Equal(t, before, healthCatalogCount(t, s),
		"an unpublished draft must not count as a seeded catalog")

	publishV1(t, optedIn, name)

	require.Equal(t, before+1, healthCatalogCount(t, s))
}
