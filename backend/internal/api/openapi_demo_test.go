package api_test

import (
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// #124: a demo account (password on the landing page) could read the whole
// OpenAPI surface of the production cluster — every group/version and every
// installed CRD. It now sees only what the demo RBAC covers.

const demoIndexBody = `{"paths":{
  "api/v1":{"serverRelativeURL":"/openapi/v3/api/v1?hash=B"},
  "apis/apps/v1":{"serverRelativeURL":"/openapi/v3/apis/apps/v1?hash=D"},
  "apis/batch/v1":{"serverRelativeURL":"/openapi/v3/apis/batch/v1?hash=E"},
  "apis/authorization.k8s.io/v1":{"serverRelativeURL":"/openapi/v3/apis/authorization.k8s.io/v1?hash=F"},
  "apis/rbac.authorization.k8s.io/v1":{"serverRelativeURL":"/openapi/v3/apis/rbac.authorization.k8s.io/v1?hash=G"},
  "apis/traefik.io/v1alpha1":{"serverRelativeURL":"/openapi/v3/apis/traefik.io/v1alpha1?hash=H"}
}}`

// demoOpenAPIRouters wires a fake apiserver, registers it through an admin
// router (a demo account may not register clusters), and returns a demo
// router and an admin router over the same store plus a count of upstream hits.
func demoOpenAPIRouters(t *testing.T) (demo, admin http.Handler, cluster string, hits *atomic.Int32) {
	t.Helper()
	hits = &atomic.Int32{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/openapi/v3" {
			_, _ = w.Write([]byte(demoIndexBody))
			return
		}
		_, _ = w.Write([]byte(`{"openapi":"3.0.0","components":{"schemas":{}}}`))
	}))
	t.Cleanup(srv.Close)

	ca := pemOf(t, srv)
	s := testStore(t)
	admin = api.NewRouter(config.Config{OpenAPICacheMax: 8},
		api.Deps{Verifier: adminVerifier{}, Store: s, DemoEmailDomain: "demo.kubeport"})
	cluster = seedClusterAt(t, admin, srv.URL, ca)
	demo = api.NewRouter(config.Config{OpenAPICacheMax: 8},
		api.Deps{Verifier: demoAdminVerifier{}, Store: s, DemoEmailDomain: "demo.kubeport"})
	hits.Store(0)
	return demo, admin, cluster, hits
}

// pemOf is the fake apiserver's certificate as the ca_bundle a cluster carries.
func pemOf(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	b := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	require.NotNil(t, b)
	return string(b)
}

func indexKeys(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var doc struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &doc))
	keys := make([]string, 0, len(doc.Paths))
	for k := range doc.Paths {
		keys = append(keys, k)
	}
	return keys
}

func TestOpenAPIDemo_IndexListsOnlyDemoGroupVersions(t *testing.T) {
	demo, _, cluster, _ := demoOpenAPIRouters(t)

	keys := indexKeys(t, do(t, demo, http.MethodGet, "/v1/clusters/"+cluster+"/openapi", nil))

	require.ElementsMatch(t, []string{"api/v1", "apis/apps/v1", "apis/batch/v1", "apis/authorization.k8s.io/v1"}, keys)
}

func TestOpenAPIDemo_OtherGroupVersionLooksAbsentAndNeverReachesTheCluster(t *testing.T) {
	demo, _, cluster, hits := demoOpenAPIRouters(t)

	for _, gv := range []string{"rbac.authorization.k8s.io/v1", "traefik.io/v1alpha1", "networking.k8s.io/v1"} {
		t.Run(gv, func(t *testing.T) {
			w := getOpenAPI(t, demo, cluster, gv)
			require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
			p := decodeProblem(t, w)
			require.Equal(t, "k8s-error", p["title"])
			require.Equal(t, "this cluster has no such group/version", p["detail"])
		})
	}
	require.Zero(t, hits.Load(), "a hidden group/version must not be fetched from the cluster")
}

func TestOpenAPIDemo_DemoGroupVersionsStillLoad(t *testing.T) {
	demo, _, cluster, _ := demoOpenAPIRouters(t)

	for _, gv := range []string{"v1", "apps/v1", "batch/v1", "authorization.k8s.io/v1"} {
		t.Run(gv, func(t *testing.T) {
			w := getOpenAPI(t, demo, cluster, gv)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		})
	}
}

func TestOpenAPIDemo_AdminStillSeesEverything(t *testing.T) {
	_, admin, cluster, _ := demoOpenAPIRouters(t)

	keys := indexKeys(t, do(t, admin, http.MethodGet, "/v1/clusters/"+cluster+"/openapi", nil))
	require.Contains(t, keys, "apis/traefik.io/v1alpha1")
	require.Contains(t, keys, "apis/rbac.authorization.k8s.io/v1")

	require.Equal(t, http.StatusOK, getOpenAPI(t, admin, cluster, "traefik.io/v1alpha1").Code)
}
