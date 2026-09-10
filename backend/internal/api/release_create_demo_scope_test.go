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

// Issue #226. The catalog list keeps demo content in the demo
// (scopeTemplatesToDemo), but POST /v1/releases looked the template up by name
// and never asked the same question. So a caller who knew a template's name
// could deploy across the line the list draws: a real user from a demo
// template, or a demo visitor from an operator's.
//
// The real-user direction is the one that did damage. A release row holds its
// template version by foreign key, and seed-demo's reset deletes the demo
// catalog in one statement that it skips on a foreign-key refusal — so a
// single such release stopped the daily reset from clearing any demo template
// (#148's last_seed alarm is what surfaces that).
//
// An out-of-scope template answers exactly like a missing one, as the list
// does: saying "exists, but not for you" would confirm a name to someone
// guessing them.

func deployBody(t *testing.T, tpl, cluster, name string) *bytes.Reader {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"template": tpl, "version": 1, "cluster": cluster, "namespace": "default",
		"name": name, "values": demoValues,
	})
	require.NoError(t, err)
	return bytes.NewReader(b)
}

// seedDemoTemplate publishes a template owned by the demo admin, the way the
// seeder's catalog is owned.
func seedDemoTemplate(t *testing.T, s *store.Store) string {
	t.Helper()
	name := "demo-tpl-" + randSuffix()
	w := do(t, newDemoAdminRouterWithTemplateCreate(t, s), http.MethodPost, "/v1/templates",
		bytes.NewReader(createTemplateBody(name)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	publishV1(t, newDemoAdminRouterWithTemplateCreate(t, s), name)
	return name
}

func TestCreateRelease_RealUserCannotDeployDemoTemplate(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedDemoTemplate(t, s)

	factory := &fakeK8sFactory{applier: &fakeK8sApplier{}}
	suffix := randSuffix()
	realUser := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "real-" + suffix, Email: "real-" + suffix + "@example.com",
		}},
		Store:           s,
		K8sFactory:      factory,
		DemoEmailDomain: demoDomain,
	})

	w := do(t, realUser, http.MethodPost, "/v1/releases", deployBody(t, tplName, clusterName, "real-"+randSuffix()))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "not-found")
	require.Zero(t, factory.calls, "nothing may reach a cluster for a template the caller cannot see")
}

func TestCreateRelease_DemoAdminCannotDeployOperatorTemplate(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter) // owned by the real operator

	applier := &fakeK8sApplier{}
	demoRouter := newDemoAdminRouter(t, s, applier)
	w := do(t, demoRouter, http.MethodPost, "/v1/releases", deployBody(t, tplName, clusterName, "demo-"+randSuffix()))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "not-found")
}

// The line is the list's, including who stands outside it: the real operator
// sees every template and may deploy any, and the demo deploys its own — which
// is what seed-demo does every night.
func TestCreateRelease_DemoScopeLeavesInScopeDeploysAlone(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}
	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier}, DemoEmailDomain: demoDomain,
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedDemoTemplate(t, s)

	createRelease(t, adminRouter, tplName, clusterName, "operator-"+randSuffix(), demoValues)
	createRelease(t, newDemoAdminRouter(t, s, applier), tplName, clusterName, "demo-"+randSuffix(), demoValues)
}
