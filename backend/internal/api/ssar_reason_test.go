package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/config"
	"kubeport/internal/k8s"
)

// The RBAC authorizer explains itself by naming the objects that granted or
// refused access:
//
//	RBAC: allowed by ClusterRoleBinding "kubeport-demo" of ClusterRole
//	"kubeport-demo-deployer" to User "demo-user@demo.kubeport"
//
// SSAR is open to every authenticated caller by design — it only ever reports
// the caller's own access — so passing that sentence through let anyone who
// can log in, the public demo included, enumerate the cluster's binding names
// one namespace at a time (issue #102). No privilege boundary is crossed; it
// is the reconnaissance that comes before one.
const rbacReason = `RBAC: allowed by ClusterRoleBinding "kubeport-demo" of ` +
	`ClusterRole "kubeport-demo-deployer" to User "demo-user@demo.kubeport"`

func ssarRouter(t *testing.T, v api.TokenVerifier, demoDomain string) (http.Handler, *fakeK8sApplier) {
	t.Helper()
	applier := &fakeK8sApplier{
		accessResult: k8s.AccessResult{Allowed: false, Denied: true, Reason: rbacReason},
	}
	r := api.NewRouter(config.Config{}, api.Deps{
		Verifier:        v,
		Store:           testStore(t),
		K8sFactory:      &fakeK8sFactory{applier: applier},
		DemoEmailDomain: demoDomain,
	})
	return r, applier
}

func askSSAR(t *testing.T, r http.Handler, cluster string) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"cluster": cluster, "namespace": "default",
		"verb": "create", "group": "apps", "resource": "deployments",
	})
	w := do(t, r, http.MethodPost, "/v1/selfsubjectaccessreview", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, "body: %s", w.Body.String())

	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	return out
}

func TestSSAR_ReasonWithheldFromNonAdmins(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	cluster := seedCluster(t, adminR)

	applier := &fakeK8sApplier{
		accessResult: k8s.AccessResult{Allowed: false, Denied: true, Reason: rbacReason},
	}
	userR := newTestRouterUserWithK8s(t, s, applier)

	out := askSSAR(t, userR, cluster)

	require.Equal(t, false, out["allowed"])
	require.Empty(t, out["reason"],
		"a non-admin must not be able to read the cluster's binding names out of a preflight check")
}

// Demo accounts carry kubeport-admin so they can show the admin UX, and the
// demo password is printed on the landing page. Treating them as admins here
// would publish the live cluster's RBAC layout to anyone who visits.
func TestSSAR_ReasonWithheldFromDemoAdmins(t *testing.T) {
	r, _ := ssarRouter(t, demoAdminVerifier{}, demoDomain)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
	cluster := seedCluster(t, adminR)

	out := askSSAR(t, r, cluster)

	require.Empty(t, out["reason"],
		"demo accounts are admins for UX purposes only; the demo password is public")
}

// A real operator still gets the sentence — it is how they find the binding
// that needs changing, and they can read the cluster's RBAC directly anyway.
func TestSSAR_ReasonKeptForRealAdmins(t *testing.T) {
	r, _ := ssarRouter(t, adminVerifier{}, demoDomain)
	cluster := seedCluster(t, r)

	out := askSSAR(t, r, cluster)

	require.Equal(t, rbacReason, out["reason"])
}
