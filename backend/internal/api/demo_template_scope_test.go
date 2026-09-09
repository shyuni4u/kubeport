package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// The public demo grants demo-admin the kubeport-admin group so it can show the
// admin UX. That made one visitor's convenience the shipped default: any demo
// visitor could author a template with no owning team, publish it, and have it
// land in every real user's catalog — permanently, because seed-demo's reset
// tolerates FK conflicts and skips a template a real user has deployed.
//
// Per docs/brainstorming-summary.md §14, the safe behaviour is the default and
// the demo opts back in at install time.

func newDemoAdminRouterWithTemplateCreate(t *testing.T, s *store.Store) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier:                demoVerifier{email: "demo-admin@" + demoDomain},
		Store:                   s,
		DemoEmailDomain:         demoDomain,
		DemoAllowTemplateCreate: true,
	})
}

// newRealUserRouter authenticates a non-demo, non-admin user against a
// deployment that has demo mode enabled.
func newRealUserRouter(t *testing.T, s *store.Store) http.Handler {
	t.Helper()
	suffix := randSuffix()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "real-" + suffix,
			Email:   "real-" + suffix + "@example.com",
		}},
		Store:           s,
		DemoEmailDomain: demoDomain,
	})
}

func createTemplateBody(name string) []byte {
	b, _ := json.Marshal(map[string]any{
		"name":           name,
		"display_name":   "Demo Authored",
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	return b
}

func TestDemoAdmin_CannotCreateTemplateByDefault(t *testing.T) {
	s := testStore(t)
	demoRouter := newDemoAdminRouter(t, s, &fakeK8sApplier{})

	w := do(t, demoRouter, http.MethodPost, "/v1/templates",
		bytes.NewReader(createTemplateBody("demo-authored-"+randSuffix())))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "demo-restricted")
}

func TestDemoAdmin_CanCreateTemplateWhenOptedIn(t *testing.T) {
	s := testStore(t)
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)

	w := do(t, optedIn, http.MethodPost, "/v1/templates",
		bytes.NewReader(createTemplateBody("demo-authored-"+randSuffix())))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}

// A real operator is unaffected by the gate, demo mode on or off.
func TestRealAdmin_CanCreateTemplateWithDemoModeOn(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, DemoEmailDomain: demoDomain,
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/templates",
		bytes.NewReader(createTemplateBody("real-"+randSuffix())))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}

// Containment, so that turning the opt-in on doesn't put demo content back in
// front of real users. Mirrors ListReleases' demo scoping.
func TestListTemplates_DemoContentStaysInTheDemo(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, DemoEmailDomain: demoDomain,
	})
	optedIn := newDemoAdminRouterWithTemplateCreate(t, s)

	realTpl := seedPublishedTemplate(t, adminRouter)

	demoTpl := "demo-authored-" + randSuffix()
	w := do(t, optedIn, http.MethodPost, "/v1/templates", bytes.NewReader(createTemplateBody(demoTpl)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, optedIn, demoTpl)

	// A real end-user sees the operator's catalog, not the demo's.
	w = do(t, newRealUserRouter(t, s), http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), realTpl)
	require.NotContains(t, w.Body.String(), demoTpl)

	// A demo visitor sees the demo's catalog, not the operator's.
	w = do(t, optedIn, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), demoTpl)
	require.NotContains(t, w.Body.String(), realTpl)

	// The real operator keeps full visibility — they need to see what is on
	// their instance, exactly as ListReleases already does for admins.
	w = do(t, adminRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), realTpl)
	require.Contains(t, w.Body.String(), demoTpl)
}

// With demo mode off (the self-hosted default) nothing is filtered.
func TestListTemplates_NoDemoScopingWhenDemoDisabled(t *testing.T) {
	s := testStore(t)
	adminRouter := newTestRouterAdmin(t)
	tpl := seedPublishedTemplate(t, adminRouter)

	userRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "plain-" + randSuffix(), Email: "plain@example.com",
		}},
		Store: s,
	})
	// The template was created against a different store handle but the same
	// database, so it is visible here.
	w := do(t, userRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), tpl)
}
