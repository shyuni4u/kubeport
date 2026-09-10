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

const demoDomain = "demo.kubeport"

// demoValues satisfies minimalUISpec's single required field.
var demoValues = map[string]any{"Deployment[web].spec.replicas": 1}

// newDemoAdminRouter authenticates as a demo-domain account that carries the
// kubeport-admin group (mirrors KBP_DEV_ADMIN_EMAILS in the live demo deploy).
func newDemoAdminRouter(t *testing.T, s *store.Store, applier *fakeK8sApplier) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier:        demoVerifier{email: "demo-admin@" + demoDomain},
		Store:           s,
		K8sFactory:      &fakeK8sFactory{applier: applier},
		DemoEmailDomain: demoDomain,
	})
}

// A demo admin must not be able to mutate a template authored by a real
// operator, even though it holds kubeport-admin.
func TestDemoAdmin_CannotEditNonDemoOwnedTemplate(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter)

	demoRouter := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	body, _ := json.Marshal(map[string]any{"display_name": "hijacked"})
	w := do(t, demoRouter, http.MethodPatch, "/v1/templates/"+tplName, bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "not-found")

	// The real admin is unaffected.
	w2 := do(t, adminRouter, http.MethodPatch, "/v1/templates/"+tplName, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w2.Code, w2.Body.String())
}

// A demo admin must not be able to read a release created by a real user.
func TestDemoAdmin_CannotReadNonDemoRelease(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)
	relID := createRelease(t, adminRouter, tplName, clusterName, "nondemo-"+randSuffix(), demoValues)

	demoRouter := newDemoAdminRouter(t, s, applier)
	w := do(t, demoRouter, http.MethodGet, "/v1/releases/"+relID, nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "demo-restricted")
}

// GET /v1/releases as a demo admin lists demo-owned releases only.
func TestDemoAdmin_ListReleasesScopedToDemoDomain(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s, K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)

	nonDemoID := createRelease(t, adminRouter, tplName, clusterName, "real-"+randSuffix(), demoValues)

	// The demo deploys from its own catalog: since #226 a demo account cannot
	// deploy the operator's template, so the demo release needs a demo one.
	demoRouter := newDemoAdminRouter(t, s, applier)
	demoID := createRelease(t, demoRouter, seedDemoTemplate(t, s), clusterName, "demo-"+randSuffix(), demoValues)

	w := do(t, demoRouter, http.MethodGet, "/v1/releases?limit=200", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var resp struct {
		Releases []struct {
			ID string `json:"id"`
		} `json:"releases"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))

	ids := make(map[string]bool, len(resp.Releases))
	for _, r := range resp.Releases {
		ids[r.ID] = true
	}
	require.True(t, ids[demoID], "demo-owned release must be listed")
	require.False(t, ids[nonDemoID], "non-demo release must not leak into the demo admin list")

	// A real admin still sees everything.
	w2 := do(t, adminRouter, http.MethodGet, "/v1/releases?limit=200", nil)
	require.Equal(t, http.StatusOK, w2.Code)
	require.Contains(t, w2.Body.String(), nonDemoID)
}
