package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
)

// Issue #252. #238 and #244 made every read and write of a template the caller
// may not see — never published, drafts not theirs to read — answer like a
// name that matches nothing. Deploying one still answered 409 "version not
// published", where a missing name answers 404, so any signed-in caller could
// confirm a hidden template's name by guessing it. It now answers like a
// missing name too; a caller who can read the drafts keeps the reasoned 409
// (TestReleases_Create_UnpublishedReturns409).
func TestCreateRelease_NeverPublishedLooksExactlyLikeMissing(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	clusterName := seedCluster(t, adminRouter)
	hidden := seedGlobalTemplate(t, adminRouter) // v1 stays a draft
	missing := "no-such-template-" + randSuffix()

	factory := &fakeK8sFactory{applier: &fakeK8sApplier{}}
	suffix := randSuffix()
	user := api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "outsider-" + suffix, Email: "outsider-" + suffix + "@example.com",
		}},
		Store:      s,
		K8sFactory: factory,
	})

	hiddenW := do(t, user, http.MethodPost, "/v1/releases", deployBody(t, hidden, clusterName, "hidden-"+randSuffix()))
	missingW := do(t, user, http.MethodPost, "/v1/releases", deployBody(t, missing, clusterName, "missing-"+randSuffix()))

	require.Equal(t, http.StatusNotFound, hiddenW.Code, hiddenW.Body.String())
	require.Equal(t, missingW.Code, hiddenW.Code)
	require.Equal(t, writeProblem(t, missingW.Body.String(), missing), writeProblem(t, hiddenW.Body.String(), hidden),
		"a hidden template and a missing one must carry the same problem")
	require.Zero(t, factory.calls, "nothing may reach a cluster for a template the caller cannot see")
}
