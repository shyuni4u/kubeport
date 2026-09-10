package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

// The other side of #226: the check must not refuse anyone the catalog shows
// the template to. A flipped branch here would 404 every demo visitor's deploy
// or every real user's, and the refusal tests alone would not notice.
//
// demoVerifier always carries kubeport-admin, so the non-admin personas — the
// live demo's demo-user, and an ordinary real user — are built here. There is
// no ownerless case: templates.owner_user_id is NOT NULL, so every template
// has an owner whose email decides its side of the line.
func TestCreateRelease_DemoScopeAllowsWhatTheCatalogShows(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)

	demoTpl := seedDemoTemplate(t, s)
	operatorTpl := seedPublishedTemplate(t, adminRouter)

	cases := []struct {
		name     string
		email    string
		template string
	}{
		{"demo-user deploys the demo catalog", "demo-user@" + demoDomain, demoTpl},
		{"real user deploys the operator's template", "real-" + randSuffix() + "@example.com", operatorTpl},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			factory := &fakeK8sFactory{applier: &fakeK8sApplier{}}
			r := api.NewRouter(config.Config{}, api.Deps{
				Verifier: customVerifier{claims: auth.Claims{
					Subject: "sub-" + randSuffix(), Email: tc.email,
				}},
				Store:           s,
				K8sFactory:      factory,
				DemoEmailDomain: demoDomain,
			})

			w := do(t, r, http.MethodPost, "/v1/releases", deployBody(t, tc.template, clusterName, "scope-"+randSuffix()))
			require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
			require.NotZero(t, factory.calls, "an allowed deploy goes on to the cluster")
		})
	}
}
