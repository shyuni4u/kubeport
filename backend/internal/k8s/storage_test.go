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

// #340: the delete confirmation says what the delete does to storage, and it
// has to be what DeleteByRelease will actually pick — the cluster's objects
// under the release's labels, not the last manifest.

func storageCluster(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			{Group: "apps", Version: "v1", Resource: "statefulsets"}: "StatefulSetList",
			{Version: "v1", Resource: "persistentvolumeclaims"}:      "PersistentVolumeClaimList",
		}, objs...)
}

// set is a StatefulSet in demo labelled for release "db" (uid "" leaves the id
// off), with claim templates when policy is not "-", and that retention policy
// when it is not empty either.
func set(name, uid, policy string) *unstructured.Unstructured {
	labels := map[string]any{k8s.ReleaseLabel: "db"}
	if uid != "" {
		labels[k8s.ReleaseUIDLabel] = uid
	}
	spec := map[string]any{}
	if policy != "-" {
		spec["volumeClaimTemplates"] = []any{map[string]any{"metadata": map[string]any{"name": "data"}}}
		if policy != "" {
			spec["persistentVolumeClaimRetentionPolicy"] = map[string]any{"whenDeleted": policy}
		}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "StatefulSet",
		"metadata": map[string]any{"name": name, "namespace": "demo", "labels": labels},
		"spec":     spec,
	}}
}

func storageRef(nameOnly bool) k8s.ReleaseRef {
	return k8s.ReleaseRef{Namespace: "demo", Name: "db", UID: "uid-db", NameOnly: nameOnly}
}

func TestStorageOnDelete(t *testing.T) {
	ownClaim := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": map[string]any{"name": "shared", "namespace": "demo",
			"labels": map[string]any{k8s.ReleaseLabel: "db", k8s.ReleaseUIDLabel: "uid-db"}},
	}}
	cases := map[string]struct {
		objs     []runtime.Object
		nameOnly bool
		want     k8s.Storage
	}{
		"a StatefulSet that deletes its claims":           {objs: []runtime.Object{set("db", "uid-db", "Delete")}, want: k8s.StorageDeleted},
		"one that retains them":                           {objs: []runtime.Object{set("db", "uid-db", "Retain")}, want: k8s.StorageKept},
		"one with no policy, applied before the default":  {objs: []runtime.Object{set("db", "uid-db", "")}, want: k8s.StorageKept},
		"one deletes and another keeps":                   {objs: []runtime.Object{set("a", "uid-db", "Retain"), set("b", "uid-db", "Delete")}, want: k8s.StorageDeleted},
		"a StatefulSet without claim templates":           {objs: []runtime.Object{set("db", "uid-db", "-")}, want: k8s.StorageNone},
		"another release's StatefulSet of the same name":  {objs: []runtime.Object{set("db", "uid-other", "Delete")}, want: k8s.StorageNone},
		"claims of its own the delete removes directly":   {objs: []runtime.Object{set("db", "uid-db", "Retain"), ownClaim}, want: k8s.StorageDeleted},
		"nothing at all":                                  {want: k8s.StorageNone},
		"an unstamped StatefulSet of a name-only release": {objs: []runtime.Object{set("db", "", "Delete")}, nameOnly: true, want: k8s.StorageDeleted},
		"an unstamped StatefulSet is not an id release's": {objs: []runtime.Object{set("db", "", "Delete")}, want: k8s.StorageNone},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := k8s.NewForTest(storageCluster(tc.objs...)).StorageOnDelete(context.Background(), storageRef(tc.nameOnly))
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

// A StatefulSet a later version dropped is still the release's in the cluster
// (an update does not prune), and still deletes its claims. That is the case
// the manifest cannot show (security review).
func TestStorageOnDelete_SeesAStatefulSetTheLastManifestDropped(t *testing.T) {
	got, err := k8s.NewForTest(storageCluster(set("dropped-in-v2", "uid-db", "Delete"))).
		StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageDeleted, got)
}

func forbidListing(dyn *dynamicfake.FakeDynamicClient, resource string) {
	dyn.PrependReactor("list", resource, func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", errors.New("the role withholds list"))
	})
}

func TestStorageOnDelete_UnlistableStatefulSetsAreUnknown(t *testing.T) {
	dyn := storageCluster(set("db", "uid-db", "Delete"))
	forbidListing(dyn, "statefulsets")
	got, err := k8s.NewForTest(dyn).StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageUnknown, got)
}

// The demo user may not list claims, and may not delete them either, so its
// delete removes none directly; its StatefulSets still decide.
func TestStorageOnDelete_UnlistableClaimsAreSkipped(t *testing.T) {
	dyn := storageCluster(set("db", "uid-db", "Retain"))
	forbidListing(dyn, "persistentvolumeclaims")
	got, err := k8s.NewForTest(dyn).StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageKept, got)
}

// Claims a Delete-retaining StatefulSet made are removed by its controller
// and the garbage collector, not by the caller: the demo user's release
// deletes them though it may neither list nor delete claims. Refused claims
// cannot turn that verdict into anything milder.
func TestStorageOnDelete_UnlistableClaimsDoNotHideAStatefulSetThatDeletes(t *testing.T) {
	dyn := storageCluster(set("db", "uid-db", "Delete"))
	forbidListing(dyn, "persistentvolumeclaims")
	got, err := k8s.NewForTest(dyn).StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageDeleted, got)
}

func TestStorageOnDelete_OtherErrorsSurface(t *testing.T) {
	dyn := storageCluster()
	dyn.PrependReactor("list", "statefulsets", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewServiceUnavailable("apiserver is restarting")
	})
	got, err := k8s.NewForTest(dyn).StorageOnDelete(context.Background(), storageRef(false))
	require.Error(t, err)
	require.Equal(t, k8s.StorageUnknown, got)
}

func TestStorageOnDelete_RefusesAnEmptyID(t *testing.T) {
	_, err := k8s.NewForTest(storageCluster()).StorageOnDelete(context.Background(), k8s.ReleaseRef{Namespace: "demo", Name: "db"})
	require.Error(t, err)
}
