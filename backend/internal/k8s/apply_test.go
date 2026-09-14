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

func TestSplitYAML_SplitsMultiDoc(t *testing.T) {
	in := []byte(`apiVersion: v1
kind: ConfigMap
metadata:
  name: alpha
data:
  hello: world
---
apiVersion: v1
kind: Secret
metadata:
  name: beta
stringData:
  password: s3cret
`)
	objs, err := k8s.SplitYAML(in)
	require.NoError(t, err)
	require.Len(t, objs, 2)

	require.Equal(t, "ConfigMap", objs[0].GetKind())
	require.Equal(t, "alpha", objs[0].GetName())
	require.Equal(t, "Secret", objs[1].GetKind())
	require.Equal(t, "beta", objs[1].GetName())
}

func TestSplitYAML_IgnoresEmptyDocs(t *testing.T) {
	in := []byte(`apiVersion: v1
kind: ConfigMap
metadata:
  name: only
---
---
`)
	objs, err := k8s.SplitYAML(in)
	require.NoError(t, err)
	require.Len(t, objs, 1)
	require.Equal(t, "only", objs[0].GetName())
}

func TestPluralize_KnownKinds(t *testing.T) {
	cases := map[string]string{
		"Deployment":            "deployments",
		"StatefulSet":           "statefulsets",
		"DaemonSet":             "daemonsets",
		"Job":                   "jobs",
		"CronJob":               "cronjobs",
		"Service":               "services",
		"Ingress":               "ingresses",
		"ConfigMap":             "configmaps",
		"Secret":                "secrets",
		"PersistentVolumeClaim": "persistentvolumeclaims",
	}
	for kind, want := range cases {
		require.Equal(t, want, k8s.Pluralize(kind), "kind=%s", kind)
	}
}

func TestPluralize_UnknownKindReturnsEmpty(t *testing.T) {
	require.Equal(t, "", k8s.Pluralize("Foo"))
	require.Equal(t, "", k8s.Pluralize(""))
}

// TestDeleteByRelease_ToleratesForbiddenAndNotFound covers RBAC-scoped
// callers such as the demo Roles (deploy/helm/kubeport/templates/demo-rbac.yaml),
// which deliberately omit some MVP resource groups/kinds. A Forbidden on a
// resource the release was not applied with, or a NotFound on any, must not
// fail the whole release delete.
func TestDeleteByRelease_ToleratesForbiddenAndNotFound(t *testing.T) {
	scheme := runtime.NewScheme()
	// The refused ingresses are not in the manifest, so the delete lists them to
	// see whether the release has any there (it has none).
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}: "IngressList",
	})

	dyn.PrependReactor("delete-collection", "ingresses", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Group: "networking.k8s.io", Resource: "ingresses"}, "", errors.New("demo RBAC does not grant this"))
	})
	dyn.PrependReactor("delete-collection", "persistentvolumeclaims", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "persistentvolumeclaims"}, "")
	})

	cli := k8s.NewForTest(dyn)
	err := cli.DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111", NameOnly: true}, deploymentAndConfigMap)
	require.NoError(t, err, "forbidden on a resource the release never used, or not-found on any, must not fail the whole delete")
}

// deploymentAndConfigMap is a release manifest that uses two MVP resources.
var deploymentAndConfigMap = []byte(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
`)

func forbid(resource string) clientgotesting.ReactionFunc {
	return func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", errors.New("RBAC does not grant this"))
	}
}

// #380: a Forbidden was skipped whatever the resource, so a caller refused on
// every kind the release actually has got a nil — the handler then dropped the
// row and left the workload in the cluster with nothing pointing at it.
func TestDeleteByRelease_RefusesWhenAResourceTheReleaseUsesIsForbidden(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	dyn.PrependReactor("delete-collection", "deployments", forbid("deployments"))
	dyn.PrependReactor("delete-collection", "configmaps", forbid("configmaps"))

	// NameOnly: two selectors per resource, so each refusal comes twice.
	ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111", NameOnly: true}
	err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, deploymentAndConfigMap)

	require.Error(t, err)
	fe, ok := err.(*k8s.DeleteForbiddenError)
	require.True(t, ok, "only refusals: the error is a DeleteForbiddenError itself, got %T: %v", err, err)
	require.Equal(t, []string{"deployments", "configmaps"}, fe.Resources, "each refused resource once")
}

// Some of the release's resources deleted, one refused: still not a success.
// The deleted ones are gone, and a retry after the RBAC is fixed finds nothing
// there, which deletes cleanly.
func TestDeleteByRelease_RefusesWhenOnlySomeOfItsResourcesAreForbidden(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	deployments := 0
	dyn.PrependReactor("delete-collection", "deployments", func(clientgotesting.Action) (bool, runtime.Object, error) {
		deployments++
		return true, nil, nil
	})
	dyn.PrependReactor("delete-collection", "configmaps", forbid("configmaps"))

	ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111"}
	err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, deploymentAndConfigMap)

	var fe *k8s.DeleteForbiddenError
	require.ErrorAs(t, err, &fe)
	require.Equal(t, []string{"configmaps"}, fe.Resources)
	require.Equal(t, 1, deployments, "the resources it may delete are still deleted")
}

// NotFound stays idempotent even on a resource the release uses: nothing of it
// is there to leave behind.
func TestDeleteByRelease_NotFoundOnAResourceTheReleaseUsesIsFine(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	dyn.PrependReactor("delete-collection", "deployments", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Group: "apps", Resource: "deployments"}, "")
	})

	ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111"}
	require.NoError(t, k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, deploymentAndConfigMap))
}

// Code review of #380: an update does not prune, so the release can still have
// objects of a kind its stored manifest no longer lists (an earlier version's,
// or one a failed update applied). A refused delete there is asked about with
// a list on the same selector: objects found are refused, nothing found or a
// list refused too (a demo Role, which has neither) is skipped as before.
func TestDeleteByRelease_ARefusalOutsideTheManifestCountsWhenItsObjectsAreThere(t *testing.T) {
	daemonset := func(uid string) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "apps/v1", "kind": "DaemonSet",
			"metadata": map[string]any{"name": "agent", "namespace": "default",
				"labels": map[string]any{k8s.ReleaseLabel: "rel-1", k8s.ReleaseUIDLabel: uid}},
		}}
	}
	const uid = "11111111-1111-1111-1111-111111111111"
	listKinds := map[schema.GroupVersionResource]string{{Group: "apps", Version: "v1", Resource: "daemonsets"}: "DaemonSetList"}
	for name, tc := range map[string]struct {
		objs       []runtime.Object
		listDenied bool
		manifest   []byte
		refused    bool
	}{
		"its objects are there":                  {objs: []runtime.Object{daemonset(uid)}, manifest: deploymentAndConfigMap, refused: true},
		"another release's are, not its own":     {objs: []runtime.Object{daemonset("22222222-2222-2222-2222-222222222222")}, manifest: deploymentAndConfigMap},
		"nothing is there":                       {manifest: deploymentAndConfigMap},
		"the list is refused too":                {objs: []runtime.Object{daemonset(uid)}, listDenied: true, manifest: deploymentAndConfigMap},
		"no manifest, and its objects are there": {objs: []runtime.Object{daemonset(uid)}, refused: true},
	} {
		t.Run(name, func(t *testing.T) {
			dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, tc.objs...)
			dyn.PrependReactor("delete-collection", "daemonsets", forbid("daemonsets"))
			if tc.listDenied {
				dyn.PrependReactor("list", "daemonsets", forbid("daemonsets"))
			}

			ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: uid}
			err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, tc.manifest)

			if !tc.refused {
				require.NoError(t, err)
				return
			}
			fe, ok := err.(*k8s.DeleteForbiddenError)
			require.True(t, ok, "got %T: %v", err, err)
			require.Equal(t, []string{"daemonsets"}, fe.Resources)
		})
	}
}

// A refusal next to another failure is not only a refusal: the other one may
// clear on a retry, so the caller must not read the whole as RBAC.
func TestDeleteByRelease_ARefusalWithAnotherFailureIsNotOnlyARefusal(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	dyn.PrependReactor("delete-collection", "deployments", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("boom")
	})
	dyn.PrependReactor("delete-collection", "configmaps", forbid("configmaps"))

	ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111"}
	err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, deploymentAndConfigMap)

	require.Error(t, err)
	_, only := err.(*k8s.DeleteForbiddenError)
	require.False(t, only)
	var fe *k8s.DeleteForbiddenError
	require.ErrorAs(t, err, &fe, "the refusal is still in there")
	require.Contains(t, err.Error(), "boom")
}

// #195: deleting selects on the release's id, so another release that shares
// the name keeps its objects. Unstamped objects are selected only for a
// NameOnly release — never for one created since, nor a failed create's cleanup.
func TestDeleteByRelease_SelectsTheReleasesIDAndUnstampedObjectsOnlyForANameOnlyRelease(t *testing.T) {
	const uid = "11111111-1111-1111-1111-111111111111"
	for _, tc := range []struct {
		nameOnly bool
		want     []string
	}{
		{true, []string{
			"kubeport.io/release=rel-1,kubeport.io/release-uid=" + uid,
			"kubeport.io/release=rel-1,!kubeport.io/release-uid",
		}},
		{false, []string{"kubeport.io/release=rel-1,kubeport.io/release-uid=" + uid}},
	} {
		dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
		var selectors []string
		dyn.PrependReactor("delete-collection", "deployments", func(action clientgotesting.Action) (bool, runtime.Object, error) {
			selectors = append(selectors, action.(clientgotesting.DeleteCollectionActionImpl).ListRestrictions.Labels.String())
			return true, nil, nil
		})

		ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: uid, NameOnly: tc.nameOnly}
		require.NoError(t, k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, nil))
		require.Equal(t, tc.want, selectors, "nameOnly=%v", tc.nameOnly)
	}
}

// Security review of #195: a batch/v1 Job orphans its pods unless the delete
// says otherwise, and a Job's pods carry no id, so they outlived the release
// under its name alone.
func TestDeleteByRelease_PropagatesToDependents(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	var policies []string
	dyn.PrependReactor("delete-collection", "jobs", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		p := action.(clientgotesting.DeleteCollectionActionImpl).DeleteOptions.PropagationPolicy
		if p == nil {
			policies = append(policies, "")
		} else {
			policies = append(policies, string(*p))
		}
		return true, nil, nil
	})

	ref := k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111"}
	require.NoError(t, k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref, nil))
	require.Equal(t, []string{"Background"}, policies)
}

// Without an id the id-selector would be `release-uid=`, which matches nothing,
// while the unstamped one still ran: a release delete that silently kept every
// stamped object.
func TestDeleteByRelease_RefusesAnEmptyID(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	calls := 0
	dyn.PrependReactor("delete-collection", "*", func(clientgotesting.Action) (bool, runtime.Object, error) {
		calls++
		return true, nil, nil
	})

	err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", NameOnly: true}, nil)

	require.Error(t, err)
	require.Zero(t, calls)
}

func TestDeleteByRelease_SurfacesOtherErrors(t *testing.T) {
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClient(scheme)

	dyn.PrependReactor("delete-collection", "deployments", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("boom")
	})

	cli := k8s.NewForTest(dyn)
	err := cli.DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111", NameOnly: true}, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "boom")
}
