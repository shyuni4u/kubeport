package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
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
