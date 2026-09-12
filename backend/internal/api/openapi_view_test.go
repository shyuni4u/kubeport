package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// #283: the OpenAPI proxy has no admin gate and the cluster serves /openapi to
// any authenticated user, so anyone who could sign in with the IdP enumerated
// every group/version and installed CRD. Now only callers who can author
// templates — a non-demo admin or a team editor — read everything; any other
// signed-in caller reads the built-in workload group/versions.

const viewIndexBody = `{"paths":{
  "api/v1":{"serverRelativeURL":"/openapi/v3/api/v1?hash=B"},
  "apis/apps/v1":{"serverRelativeURL":"/openapi/v3/apis/apps/v1?hash=D"},
  "apis/batch/v1":{"serverRelativeURL":"/openapi/v3/apis/batch/v1?hash=E"},
  "apis/networking.k8s.io/v1":{"serverRelativeURL":"/openapi/v3/apis/networking.k8s.io/v1?hash=N"},
  "apis/authorization.k8s.io/v1":{"serverRelativeURL":"/openapi/v3/apis/authorization.k8s.io/v1?hash=F"},
  "apis/rbac.authorization.k8s.io/v1":{"serverRelativeURL":"/openapi/v3/apis/rbac.authorization.k8s.io/v1?hash=G"},
  "apis/traefik.io/v1alpha1":{"serverRelativeURL":"/openapi/v3/apis/traefik.io/v1alpha1?hash=H"},
  "apis/cert-manager.io/v1":{"serverRelativeURL":"/openapi/v3/apis/cert-manager.io/v1?hash=I"}
}}`

var builtinIndexKeys = []string{"api/v1", "apis/apps/v1", "apis/batch/v1", "apis/networking.k8s.io/v1"}

// openapiViewFixture registers a fake apiserver through an admin router and
// returns the store, the admin router, the cluster name and a count of
// upstream hits (reset to zero).
func openapiViewFixture(t *testing.T) (s *store.Store, admin http.Handler, cluster string, hits *atomic.Int32) {
	t.Helper()
	hits = &atomic.Int32{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/openapi/v3" {
			_, _ = w.Write([]byte(viewIndexBody))
			return
		}
		_, _ = w.Write([]byte(`{"openapi":"3.0.0","components":{"schemas":{}}}`))
	}))
	t.Cleanup(srv.Close)

	s = testStore(t)
	admin = api.NewRouter(config.Config{OpenAPICacheMax: 8}, api.Deps{Verifier: adminVerifier{}, Store: s})
	cluster = seedClusterAt(t, admin, srv.URL, pemOf(t, srv))
	hits.Store(0)
	return s, admin, cluster, hits
}

// memberRouter creates a user and returns their email and a router
// authenticated as them. A non-empty teamID and role also puts them in the team.
func memberRouter(t *testing.T, s *store.Store, admin http.Handler, teamID, role string) (string, http.Handler) {
	t.Helper()
	suffix := randSuffix()
	email := "openapi-view-" + suffix + "@example.com"
	subject := "openapi-view-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText("member"),
	})
	require.NoError(t, err)
	if teamID != "" {
		addMember(t, admin, teamID, email, role)
	}
	return email, api.NewRouter(config.Config{OpenAPICacheMax: 8}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}},
		Store:    s,
	})
}

func requireLooksAbsent(t *testing.T, r http.Handler, cluster, gv string) {
	t.Helper()
	w := getOpenAPI(t, r, cluster, gv)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	p := decodeProblem(t, w)
	require.Equal(t, "k8s-error", p["title"])
	require.Equal(t, "this cluster has no such group/version", p["detail"])
}

func TestOpenAPIView_NonEditorsReadOnlyBuiltinGroupVersions(t *testing.T) {
	s, admin, cluster, hits := openapiViewFixture(t)
	team := createTeam(t, admin, "openapi-view-"+randSuffix())

	// A subject with no users row yet is not an editor, and not an error.
	stranger := api.NewRouter(config.Config{OpenAPICacheMax: 8}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{Subject: "openapi-stranger-" + randSuffix(), Email: "stranger@example.com"}},
		Store:    s,
	})
	_, noTeam := memberRouter(t, s, admin, "", "")
	_, viewer := memberRouter(t, s, admin, team, "viewer")

	for name, r := range map[string]http.Handler{"no users row": stranger, "no team": noTeam, "team viewer": viewer} {
		t.Run(name, func(t *testing.T) {
			keys := indexKeys(t, do(t, r, http.MethodGet, "/v1/clusters/"+cluster+"/openapi", nil))
			require.ElementsMatch(t, builtinIndexKeys, keys)

			for _, gv := range []string{"v1", "apps/v1", "batch/v1", "networking.k8s.io/v1"} {
				require.Equal(t, http.StatusOK, getOpenAPI(t, r, cluster, gv).Code, gv)
			}

			before := hits.Load()
			for _, gv := range []string{"traefik.io/v1alpha1", "cert-manager.io/v1", "rbac.authorization.k8s.io/v1", "authorization.k8s.io/v1"} {
				requireLooksAbsent(t, r, cluster, gv)
			}
			require.Equal(t, before, hits.Load(), "a hidden group/version must not be fetched from the cluster")
		})
	}
}

func TestOpenAPIView_TeamEditorReadsEverything(t *testing.T) {
	s, admin, cluster, _ := openapiViewFixture(t)
	team := createTeam(t, admin, "openapi-view-"+randSuffix())
	_, editor := memberRouter(t, s, admin, team, "editor")

	keys := indexKeys(t, do(t, editor, http.MethodGet, "/v1/clusters/"+cluster+"/openapi", nil))
	require.Contains(t, keys, "apis/traefik.io/v1alpha1")
	require.Contains(t, keys, "apis/cert-manager.io/v1")
	require.Len(t, keys, 8)

	require.Equal(t, http.StatusOK, getOpenAPI(t, editor, cluster, "traefik.io/v1alpha1").Code)
}

// The view is in the cache key and decided on every request, so a role change
// takes effect on the next read — a demoted editor must not keep reading the
// full index cached under their subject for the rest of the hour.
func TestOpenAPIView_RoleChangeTakesEffectDespiteTheCache(t *testing.T) {
	s, admin, cluster, _ := openapiViewFixture(t)
	team := createTeam(t, admin, "openapi-view-"+randSuffix())
	email, r := memberRouter(t, s, admin, team, "editor")
	index := "/v1/clusters/" + cluster + "/openapi"

	require.Len(t, indexKeys(t, do(t, r, http.MethodGet, index, nil)), 8)
	require.Equal(t, http.StatusOK, getOpenAPI(t, r, cluster, "traefik.io/v1alpha1").Code)

	addMember(t, admin, team, email, "viewer")
	require.ElementsMatch(t, builtinIndexKeys, indexKeys(t, do(t, r, http.MethodGet, index, nil)))
	requireLooksAbsent(t, r, cluster, "traefik.io/v1alpha1")

	addMember(t, admin, team, email, "editor")
	require.Len(t, indexKeys(t, do(t, r, http.MethodGet, index, nil)), 8)
}
