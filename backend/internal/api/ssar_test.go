package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// newSSARRouter returns a router wired with a controllable fakeK8sApplier and
// factory so tests can inject allowed / denied / error responses without a
// real cluster.
func newSSARRouter(t *testing.T) (http.Handler, *fakeK8sApplier, *fakeK8sFactory) {
	t.Helper()
	applier := &fakeK8sApplier{}
	factory := &fakeK8sFactory{applier: applier}
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:   adminVerifier{},
		Store:      testStore(t),
		K8sFactory: factory,
	})
	return r, applier, factory
}

func TestSSAR_BadJSON(t *testing.T) {
	r, _, _ := newSSARRouter(t)
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader([]byte("not-json")))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "validation-error")
}

func TestSSAR_MissingRequired(t *testing.T) {
	r, _, _ := newSSARRouter(t)

	// Empty body
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader([]byte(`{}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "validation-error")
	require.Contains(t, w.Body.String(), "cluster, verb, and resource are required")

	// Only cluster — verb & resource still missing
	body, _ := json.Marshal(map[string]any{"cluster": "x"})
	w = do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "cluster, verb, and resource are required")

	// cluster + verb, resource missing
	body, _ = json.Marshal(map[string]any{"cluster": "x", "verb": "create"})
	w = do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSSAR_UnknownCluster(t *testing.T) {
	r, _, _ := newSSARRouter(t)

	body, _ := json.Marshal(map[string]any{
		"cluster":  "does-not-exist-" + randSuffix(),
		"verb":     "create",
		"group":    "apps",
		"resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Contains(t, w.Body.String(), "not-found")
}

func TestSSAR_Allowed(t *testing.T) {
	r, applier, _ := newSSARRouter(t)
	clusterName := seedCluster(t, r)

	applier.accessResult = k8s.AccessResult{Allowed: true, Denied: false, Reason: ""}

	body, _ := json.Marshal(map[string]any{
		"cluster":   clusterName,
		"namespace": "default",
		"verb":      "create",
		"group":     "apps",
		"resource":  "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, true, got["allowed"])
	require.Equal(t, false, got["denied"])
	require.Equal(t, "", got["reason"])

	// Handler forwarded the request fields verbatim.
	require.Len(t, applier.accessChecks, 1)
	require.Equal(t, k8s.AccessCheck{
		Namespace: "default",
		Verb:      "create",
		Group:     "apps",
		Resource:  "deployments",
	}, applier.accessChecks[0])
}

func TestSSAR_Denied(t *testing.T) {
	r, applier, _ := newSSARRouter(t)
	clusterName := seedCluster(t, r)

	applier.accessResult = k8s.AccessResult{
		Allowed: false,
		Denied:  true,
		Reason:  "RBAC: role alice-ro does not grant create on deployments",
	}

	body, _ := json.Marshal(map[string]any{
		"cluster":   clusterName,
		"namespace": "prod",
		"verb":      "create",
		"group":     "apps",
		"resource":  "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, false, got["allowed"])
	require.Equal(t, true, got["denied"])
	require.Equal(t, "RBAC: role alice-ro does not grant create on deployments", got["reason"])
}

func TestSSAR_K8sFactoryError(t *testing.T) {
	r, _, factory := newSSARRouter(t)
	clusterName := seedCluster(t, r)

	factory.err = errors.New("caBundle parse failure")

	body, _ := json.Marshal(map[string]any{
		"cluster":  clusterName,
		"verb":     "create",
		"group":    "apps",
		"resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	// The client construction error names the cluster's api_url (see #96), so
	// it goes to the log, not the response — #49. The caller still learns which
	// operation failed.
	require.Contains(t, w.Body.String(), "CheckSelfSubjectAccess")
	require.NotContains(t, w.Body.String(), "caBundle parse failure")
}

func TestSSAR_K8sCheckError(t *testing.T) {
	r, applier, _ := newSSARRouter(t)
	clusterName := seedCluster(t, r)

	applier.accessErr = errors.New("connection refused")

	body, _ := json.Marshal(map[string]any{
		"cluster":  clusterName,
		"verb":     "create",
		"group":    "apps",
		"resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview",
		bytes.NewReader(body))
	require.Equal(t, http.StatusBadGateway, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "k8s-error")
	require.Contains(t, w.Body.String(), "connection refused")
}
