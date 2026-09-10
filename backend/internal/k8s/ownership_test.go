package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgotesting "k8s.io/client-go/testing"

	"kubeport/internal/k8s"
)

// cluster builds a fake apiserver holding objs. List kinds are registered so
// the tracker accepts the unstructured objects without a typed scheme.
func cluster(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			{Group: "apps", Version: "v1", Resource: "deployments"}: "DeploymentList",
			{Version: "v1", Resource: "configmaps"}:                 "ConfigMapList",
			{Version: "v1", Resource: "services"}:                   "ServiceList",
			{Version: "v1", Resource: "secrets"}:                    "SecretList",
		}, objs...)
}

// existing is an object already in the cluster. owner "" means it carries no
// release label, i.e. kubeport did not create it.
func existing(apiVersion, kind, namespace, name, owner string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion(apiVersion)
	u.SetKind(kind)
	u.SetNamespace(namespace)
	u.SetName(name)
	if owner != "" {
		u.SetLabels(map[string]string{k8s.ReleaseLabel: owner})
	}
	return u
}

// webApp is what the demo's web-app template renders for a release: three
// objects whose names are fixed by the template, not by the release.
const webApp = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  labels: {kubeport.io/release: verify-autorefresh}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: {kubeport.io/release: verify-autorefresh}
---
apiVersion: v1
kind: Service
metadata:
  name: web
  labels: {kubeport.io/release: verify-autorefresh}
`

func TestCheckApply_NothingThereIsNoConflict(t *testing.T) {
	cli := k8s.NewForTest(cluster())

	got, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.NoError(t, err)
	require.Empty(t, got.Conflicts)
	require.Empty(t, got.Unverified)
}

// An update re-applies a release over its own objects. That must stay allowed,
// or every PUT /v1/releases/:id would refuse itself.
func TestCheckApply_OwnObjectsAreNotAConflict(t *testing.T) {
	cli := k8s.NewForTest(cluster(
		existing("v1", "ConfigMap", "demo", "web-config", "verify-autorefresh"),
		existing("apps/v1", "Deployment", "demo", "web", "verify-autorefresh"),
	))

	got, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.NoError(t, err)
	require.Empty(t, got.Conflicts)
}

// #161 as it happened live: the seeded web-app-demo owned these objects, a
// second web-app release took them over on create, and deleting it took the
// seed's resources with it.
func TestCheckApply_AnotherReleasesObjectsAreConflicts(t *testing.T) {
	cli := k8s.NewForTest(cluster(
		existing("v1", "ConfigMap", "demo", "web-config", "web-app-demo"),
		existing("apps/v1", "Deployment", "demo", "web", "web-app-demo"),
		// Service/web absent: creating it takes nothing from anyone.
	))

	got, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "web-config", Namespace: "demo"}, Owner: "web-app-demo"},
		{ObjectRef: k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "demo"}, Owner: "web-app-demo"},
	}, got.Conflicts)
}

// Something kubeport did not create is not free to take either: applying with
// Force would adopt it, and deleting the release would then delete it.
func TestCheckApply_UnlabelledObjectIsAConflictWithNoOwner(t *testing.T) {
	cli := k8s.NewForTest(cluster(
		existing("apps/v1", "Deployment", "demo", "web", ""),
	))

	got, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "Deployment", Name: "web", Namespace: "demo"}, Owner: ""},
	}, got.Conflicts)
}

// Ownership is per namespace, like the objects themselves.
func TestCheckApply_SameNameInAnotherNamespaceIsNotAConflict(t *testing.T) {
	cli := k8s.NewForTest(cluster(
		existing("apps/v1", "Deployment", "other", "web", "web-app-demo"),
	))

	got, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.NoError(t, err)
	require.Empty(t, got.Conflicts)
}

// The demo Role may write Secrets but not read them. Refusing on that would make
// every template carrying a Secret undeployable for a demo user, so the object is
// reported as unverified and left to apply as before.
func TestCheckApply_UnreadableObjectIsUnverifiedNotAConflict(t *testing.T) {
	dyn := cluster()
	dyn.PrependReactor("get", "secrets", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "secrets"}, "app-secret", errors.New("demo role withholds get"))
	})
	cli := k8s.NewForTest(dyn)

	doc := `apiVersion: v1
kind: Secret
metadata:
  name: app-secret
`
	got, err := cli.CheckApply(context.Background(), "demo", "cfg-demo", []byte(doc))

	require.NoError(t, err)
	require.Empty(t, got.Conflicts)
	require.Equal(t, []k8s.ObjectRef{{Kind: "Secret", Name: "app-secret", Namespace: "demo"}}, got.Unverified)
}

// Letting an unreadable object through is safe only while it cannot hide a
// readable conflict. app-with-config is the real case: its Secret is unreadable
// to a demo user, but its ConfigMap and Deployment are not, and they must still
// be reported even when the Secret comes first in the manifest.
func TestCheckApply_KeepsCheckingPastAnUnreadableObject(t *testing.T) {
	dyn := cluster(
		existing("v1", "ConfigMap", "demo", "app-config", "cfg-demo"),
	)
	dyn.PrependReactor("get", "secrets", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "secrets"}, "app-secret", errors.New("demo role withholds get"))
	})
	cli := k8s.NewForTest(dyn)

	doc := `apiVersion: v1
kind: Secret
metadata:
  name: app-secret
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
`
	got, err := cli.CheckApply(context.Background(), "demo", "visitor-cfg", []byte(doc))

	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: "ConfigMap", Name: "app-config", Namespace: "demo"}, Owner: "cfg-demo"},
	}, got.Conflicts)
	require.Equal(t, []k8s.ObjectRef{{Kind: "Secret", Name: "app-secret", Namespace: "demo"}}, got.Unverified)
}

// Anything else is not a verdict about ownership, so it cannot be read as "free".
func TestCheckApply_OtherErrorsSurface(t *testing.T) {
	dyn := cluster()
	dyn.PrependReactor("get", "deployments", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection reset")
	})
	cli := k8s.NewForTest(dyn)

	_, err := cli.CheckApply(context.Background(), "demo", "verify-autorefresh", []byte(webApp))

	require.Error(t, err)
	require.Contains(t, err.Error(), "connection reset")
	require.Contains(t, err.Error(), "Deployment/web")
}

// #137: kubeport records the release's namespace and deletes and lists only
// there, so an object applied into another one is orphaned the moment it lands.
func TestCheckApply_RefusesAnObjectPinnedToAnotherNamespace(t *testing.T) {
	dyn := cluster()
	var reads int
	dyn.PrependReactor("get", "*", func(clientgotesting.Action) (bool, runtime.Object, error) {
		reads++
		return false, nil, nil
	})
	cli := k8s.NewForTest(dyn)

	doc := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: kube-system
`
	_, err := cli.CheckApply(context.Background(), "demo", "rel", []byte(doc))

	var mismatch *k8s.NamespaceMismatchError
	require.ErrorAs(t, err, &mismatch)
	require.Equal(t, "kube-system", mismatch.Object.Namespace)
	require.Equal(t, "demo", mismatch.ReleaseNamespace)
	require.Contains(t, err.Error(), "remove metadata.namespace from the template")
	require.Zero(t, reads, "nothing should be looked up for an object that will not be applied")
}

// Naming the release's own namespace explicitly is not a mismatch.
func TestCheckApply_AcceptsTheReleasesOwnNamespaceWrittenOut(t *testing.T) {
	cli := k8s.NewForTest(cluster())

	doc := `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: demo
`
	got, err := cli.CheckApply(context.Background(), "demo", "rel", []byte(doc))

	require.NoError(t, err)
	require.Empty(t, got.Conflicts)
}

// ApplyAll enforces the same rule on its own, because not every apply is
// preceded by a check — UpdateRelease's rollback re-applies stored YAML.
func TestApplyAll_RefusesAnObjectPinnedToAnotherNamespace(t *testing.T) {
	dyn := cluster()
	var patched []string
	dyn.PrependReactor("patch", "*", func(a clientgotesting.Action) (bool, runtime.Object, error) {
		patched = append(patched, a.GetNamespace()+"/"+a.GetResource().Resource)
		return true, &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "ConfigMap"}}, nil
	})
	cli := k8s.NewForTest(dyn)

	doc := `apiVersion: v1
kind: ConfigMap
metadata:
  name: stays
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: escapes
  namespace: kube-system
`
	err := cli.ApplyAll(context.Background(), "demo", []byte(doc))

	var mismatch *k8s.NamespaceMismatchError
	require.ErrorAs(t, err, &mismatch)
	require.Equal(t, []string{"demo/configmaps"}, patched, "only the object in the release's namespace may be applied")
}
