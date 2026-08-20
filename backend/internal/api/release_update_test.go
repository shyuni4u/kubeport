package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
)

// createRelease is a test helper that POSTs a release with the given admin
// router + seeded cluster/template and returns the release ID.
func createRelease(t *testing.T, r http.Handler, tplName, clusterName, relName string, values map[string]any) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"template":  tplName,
		"version":   1,
		"cluster":   clusterName,
		"namespace": "default",
		"name":      relName,
		"values":    values,
	})
	w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, "create: %s", w.Body.String())
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	return created["id"].(string)
}

// TestUpdateRelease_BadRequest: malformed body → 400.
func TestUpdateRelease_BadRequest(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "rel-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	w := do(t, r, http.MethodPut, "/v1/releases/"+id, strings.NewReader("{not json"))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}

// TestUpdateRelease_NotFound: unknown release UUID → 404.
func TestUpdateRelease_NotFound(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	body, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{},
	})
	w := do(t, r, http.MethodPut, "/v1/releases/00000000-0000-0000-0000-000000000000",
		bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

// TestUpdateRelease_InvalidVersion: version <= 0 → 400.
func TestUpdateRelease_InvalidVersion(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "rel-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	body, _ := json.Marshal(map[string]any{
		"version": 0,
		"values":  map[string]any{"Deployment[web].spec.replicas": 2},
	})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

// TestUpdateRelease_MissingValues: values omitted → 400 (values required).
func TestUpdateRelease_MissingValues(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "rel-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	// version only, no values
	w := do(t, r, http.MethodPut, "/v1/releases/"+id,
		strings.NewReader(`{"version":1}`))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

// TestUpdateRelease_NullValues: values explicitly set to JSON null → 400.
//
// Gin's `binding:"required"` tag allows null through (it's "present"), which
// would silently reset the release to template defaults. UpdateRelease
// rejects it explicitly so this footgun can't hit.
func TestUpdateRelease_NullValues(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "null-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})
	appliedBefore := len(fk.applied)

	w := do(t, r, http.MethodPut, "/v1/releases/"+id,
		strings.NewReader(`{"version":1,"values":null}`))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "values must be a JSON object")
	require.Len(t, fk.applied, appliedBefore, "null values must not reach k8s apply")
}

// TestUpdateRelease_Forbidden: non-admin, non-creator user → 403.
//
// Admin seeds the release (creator=admin), then a non-admin user (stubVerifier)
// tries to PUT; should get 403.
func TestUpdateRelease_Forbidden(t *testing.T) {
	s := testStore(t)
	applier := &fakeK8sApplier{}

	adminRouter := api.NewRouter(config.Config{}, api.Deps{
		Verifier: adminVerifier{}, Store: s,
		K8sFactory: &fakeK8sFactory{applier: applier},
	})
	clusterName := seedCluster(t, adminRouter)
	tplName := seedPublishedTemplate(t, adminRouter)
	id := createRelease(t, adminRouter, tplName, clusterName, "rel-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	userRouter := newTestRouterUserWithK8s(t, s, applier)
	body, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{"Deployment[web].spec.replicas": 2},
	})
	w := do(t, userRouter, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "not the release owner")
}

// TestUpdateRelease_Success: admin updates values; DB row reflects new
// values and rendered_yaml; k8s apply is invoked again.
func TestUpdateRelease_Success(t *testing.T) {
	r, fk := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	relName := "update-" + randSuffix()
	id := createRelease(t, r, tplName, clusterName, relName, map[string]any{
		"Deployment[web].spec.replicas": 1,
	})
	require.Len(t, fk.applied, 1, "create should have applied once")

	// PUT with new values
	body, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{"Deployment[web].spec.replicas": 5},
	})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, id, got["id"])
	require.EqualValues(t, 1, got["version"])

	// Apply was called again (create + update = 2)
	require.Len(t, fk.applied, 2, "update should trigger another k8s apply")
	require.Contains(t, string(fk.applied[1]), "replicas: 5")

	// GET reflects new values + rendered yaml
	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	var detail map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &detail))
	require.Contains(t, detail["rendered_yaml"], "replicas: 5")
	// Template/cluster/namespace are immutable — unchanged.
	tpl := detail["template"].(map[string]any)
	require.Equal(t, tplName, tpl["name"])
	require.Equal(t, clusterName, detail["cluster"])
	require.Equal(t, "default", detail["namespace"])
	require.Equal(t, relName, detail["name"])
}

// TestUpdateRelease_IgnoresImmutableFields: request body may include
// template/cluster/namespace/name keys, but they're ignored (not in the
// request struct). Confirm the release's template/cluster/namespace/name
// are unchanged after such a PUT.
func TestUpdateRelease_IgnoresImmutableFields(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	relName := "immut-" + randSuffix()
	id := createRelease(t, r, tplName, clusterName, relName, map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	// Hostile payload: attempts to change immutable fields.
	body, _ := json.Marshal(map[string]any{
		"version":   1,
		"values":    map[string]any{"Deployment[web].spec.replicas": 3},
		"template":  "some-other-template",
		"cluster":   "some-other-cluster",
		"namespace": "evil-ns",
		"name":      "evil-name",
	})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// GET — confirm nothing was renamed / moved.
	w = do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	tpl := got["template"].(map[string]any)
	require.Equal(t, tplName, tpl["name"])
	require.Equal(t, clusterName, got["cluster"])
	require.Equal(t, "default", got["namespace"])
	require.Equal(t, relName, got["name"])
}

// TestUpdateRelease_UnknownVersion: bump to a version that doesn't exist → 400.
//
// NOTE on status: the version must be valid for the release's template.
// Choosing 400 (per plan spec) since "unknown version for this template" is a
// client-side mistake rather than a missing resource identified by the URL.
func TestUpdateRelease_UnknownVersion(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "unk-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	body, _ := json.Marshal(map[string]any{
		"version": 99,
		"values":  map[string]any{"Deployment[web].spec.replicas": 2},
	})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}

// TestUpdateRelease_DeprecatedVersion: updating to a deprecated version → 400.
//
// Seed v1 (published), publish v2, deprecate v2, then try to update the
// release to v2. Since the template only has v1 by default in the test
// helper, we first need a second version — skip this test until the
// helper supports multiple versions. Using v1 deprecated + release on v1
// tests the path via recreating the release scenario.
//
// Simplified approach: deprecate v1, then try to update (still v1) → 400.
func TestUpdateRelease_DeprecatedVersion(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "dep-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	w := do(t, r, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/deprecate", nil)
	require.Equal(t, http.StatusOK, w.Code)

	body, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{"Deployment[web].spec.replicas": 2},
	})
	w = do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "deprecated")
}

// TestUpdateRelease_RenderError: values violating ui-spec → 400 validation-error.
// minimalUISpec has max=20; send 999.
func TestUpdateRelease_RenderError(t *testing.T) {
	r, _ := newTestRouterWithK8s(t)
	clusterName := seedCluster(t, r)
	tplName := seedPublishedTemplate(t, r)
	id := createRelease(t, r, tplName, clusterName, "bad-"+randSuffix(), map[string]any{
		"Deployment[web].spec.replicas": 1,
	})

	body, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]any{"Deployment[web].spec.replicas": 999},
	})
	w := do(t, r, http.MethodPut, "/v1/releases/"+id, bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation-error")
}
