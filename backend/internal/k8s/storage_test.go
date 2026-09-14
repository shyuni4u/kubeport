package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	authv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
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

// ownClaim is a claim the template applied itself, carrying the release's
// labels, so DeleteByRelease deletes it directly with the caller's token.
func ownClaim() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": map[string]any{"name": "shared", "namespace": "demo",
			"labels": map[string]any{k8s.ReleaseLabel: "db", k8s.ReleaseUIDLabel: "uid-db"}},
	}}
}

// codex review: a labelled claim is deleted only if the caller may delete it;
// DeleteByRelease skips a refused delete-collection and leaves it.
func TestStorageOnDelete_ClaimsOfItsOwnCountOnlyIfTheCallerMayDeleteThem(t *testing.T) {
	for name, tc := range map[string]struct {
		cs   bool
		ok   bool
		err  error
		want k8s.Storage
	}{
		"it may delete them":               {cs: true, ok: true, want: k8s.StorageDeleted},
		"it may not: the StatefulSet says": {cs: true, ok: false, want: k8s.StorageKept},
		"the review fails":                 {cs: true, err: errors.New("simulated timeout"), want: k8s.StorageUnknown},
		"nothing to ask with":              {cs: false, want: k8s.StorageUnknown},
	} {
		t.Run(name, func(t *testing.T) {
			dyn := storageCluster(set("db", "uid-db", "Retain"), ownClaim())
			cli := k8s.NewForTest(dyn)
			if tc.cs {
				cs, _ := accessAnswer(tc.ok, tc.err)
				cli = k8s.NewForTestWithClientset(dyn, cs)
			}
			got, err := cli.StorageOnDelete(context.Background(), storageRef(false))
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestStorageOnDelete(t *testing.T) {
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

// accessAnswer is a clientset whose SelfSubjectAccessReviews answer allowed,
// or fail with err; seen records what each one asked.
func accessAnswer(allowed bool, err error) (*k8sfake.Clientset, *[]authv1.ResourceAttributes) {
	cs := k8sfake.NewSimpleClientset()
	var seen []authv1.ResourceAttributes
	cs.PrependReactor("create", "selfsubjectaccessreviews", func(a clientgotesting.Action) (bool, runtime.Object, error) {
		review := a.(clientgotesting.CreateAction).GetObject().(*authv1.SelfSubjectAccessReview)
		seen = append(seen, *review.Spec.ResourceAttributes)
		if err != nil {
			return true, nil, err
		}
		return true, &authv1.SelfSubjectAccessReview{Status: authv1.SubjectAccessReviewStatus{Allowed: allowed}}, nil
	})
	return cs, &seen
}

// The demo user may not list claims, and the cluster says it may not delete
// them either, so its delete removes none directly; its StatefulSets decide.
func TestStorageOnDelete_ClaimsTheCallerCanNeitherListNorDeleteAreSkipped(t *testing.T) {
	dyn := storageCluster(set("db", "uid-db", "Retain"))
	forbidListing(dyn, "persistentvolumeclaims")
	cs, seen := accessAnswer(false, nil)
	got, err := k8s.NewForTestWithClientset(dyn, cs).StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageKept, got)
	require.Equal(t, []authv1.ResourceAttributes{
		{Namespace: "demo", Verb: "deletecollection", Resource: "persistentvolumeclaims"},
	}, *seen, "asked once, about exactly what DeleteByRelease does to claims")
}

// codex review: list and deletecollection are granted separately. A caller
// that may delete claims it cannot list gets no promise that storage stays.
func TestStorageOnDelete_ClaimsTheCallerMayDeleteButNotListAreUnknown(t *testing.T) {
	for name, answer := range map[string]struct {
		allowed bool
		err     error
	}{
		"allowed":          {allowed: true},
		"the review fails": {err: errors.New("simulated timeout")},
	} {
		t.Run(name, func(t *testing.T) {
			dyn := storageCluster(set("db", "uid-db", "Retain"))
			forbidListing(dyn, "persistentvolumeclaims")
			cs, _ := accessAnswer(answer.allowed, answer.err)
			got, err := k8s.NewForTestWithClientset(dyn, cs).StorageOnDelete(context.Background(), storageRef(false))
			require.NoError(t, err)
			require.Equal(t, k8s.StorageUnknown, got)
		})
	}

	// A client with nothing to ask with cannot say no either.
	dyn := storageCluster(set("db", "uid-db", "-"))
	forbidListing(dyn, "persistentvolumeclaims")
	got, err := k8s.NewForTest(dyn).StorageOnDelete(context.Background(), storageRef(false))
	require.NoError(t, err)
	require.Equal(t, k8s.StorageUnknown, got)
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

// The warning is only as right as its selectors: they have to be the ones
// DeleteByRelease deletes StatefulSets by (security review). Asked of the same
// fake, the two must name the same objects.
func TestStorageOnDelete_ListsStatefulSetsByTheSelectorsDeleteByReleaseDeletesBy(t *testing.T) {
	for _, nameOnly := range []bool{false, true} {
		dyn := storageCluster()
		var listed, deleted []string
		dyn.PrependReactor("list", "statefulsets", func(a clientgotesting.Action) (bool, runtime.Object, error) {
			listed = append(listed, a.(clientgotesting.ListAction).GetListRestrictions().Labels.String())
			return false, nil, nil
		})
		dyn.PrependReactor("delete-collection", "*", func(a clientgotesting.Action) (bool, runtime.Object, error) {
			if a.GetResource().Resource == "statefulsets" {
				deleted = append(deleted, a.(clientgotesting.DeleteCollectionAction).GetListRestrictions().Labels.String())
			}
			return true, nil, nil
		})
		cli := k8s.NewForTest(dyn)
		_, err := cli.StorageOnDelete(context.Background(), storageRef(nameOnly))
		require.NoError(t, err)
		require.NoError(t, cli.DeleteByRelease(context.Background(), storageRef(nameOnly), nil))
		require.NotEmpty(t, listed)
		require.Equal(t, deleted, listed, "nameOnly=%v", nameOnly)
	}
}

func TestStorageOnDelete_RefusesAnEmptyID(t *testing.T) {
	_, err := k8s.NewForTest(storageCluster()).StorageOnDelete(context.Background(), k8s.ReleaseRef{Namespace: "demo", Name: "db"})
	require.Error(t, err)
}
