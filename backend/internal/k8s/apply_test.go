package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
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
// which deliberately omit some MVP resource groups/kinds. A Forbidden or
// NotFound on one resource in the fixed mvpResources sweep must not fail the
// whole release delete.
func TestDeleteByRelease_ToleratesForbiddenAndNotFound(t *testing.T) {
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClient(scheme)

	dyn.PrependReactor("delete-collection", "ingresses", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Group: "networking.k8s.io", Resource: "ingresses"}, "", errors.New("demo RBAC does not grant this"))
	})
	dyn.PrependReactor("delete-collection", "persistentvolumeclaims", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "persistentvolumeclaims"}, "")
	})

	cli := k8s.NewForTest(dyn)
	err := cli.DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111", NameOnly: true})
	require.NoError(t, err, "forbidden/not-found on individual resources must not fail the whole delete")
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
		require.NoError(t, k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref))
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
	require.NoError(t, k8s.NewForTest(dyn).DeleteByRelease(context.Background(), ref))
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

	err := k8s.NewForTest(dyn).DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", NameOnly: true})

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
	err := cli.DeleteByRelease(context.Background(), k8s.ReleaseRef{Namespace: "default", Name: "rel-1", UID: "11111111-1111-1111-1111-111111111111", NameOnly: true})
	require.Error(t, err)
	require.Contains(t, err.Error(), "boom")
}
