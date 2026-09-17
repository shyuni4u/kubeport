package api_test

import (
	"github.com/stretchr/testify/require"
	"kubeport/internal/api"
	"kubeport/internal/config"
	"net/http"
	"testing"
)

func TestDeleteTemplate_Admin(t *testing.T) {
	r := newTestRouterAdmin(t)
	name := seedGlobalTemplate(t, r)
	w := do(t, r, http.MethodDelete, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	w = do(t, r, http.MethodGet, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusNotFound, w.Code)
	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusNotFound, w.Code)
}
func TestDeleteTemplate_NonAdmin(t *testing.T) {
	s := testStore(t)
	admin := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	user := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
	name := seedGlobalTemplate(t, admin)
	w := do(t, user, http.MethodDelete, "/v1/templates/"+name, nil)
	require.Contains(t, []int{http.StatusForbidden, http.StatusNotFound}, w.Code)
	w = do(t, admin, http.MethodGet, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestDeleteTemplate_InUseKeepsVersions(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	cluster := seedCluster(t, r)
	name := seedPublishedTemplate(t, r)
	seedReleaseAdmin(t, r, cluster, name, "delete-in-use")
	w := do(t, r, http.MethodDelete, "/v1/templates/"+name, nil)
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "conflict")
	w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code)
}
