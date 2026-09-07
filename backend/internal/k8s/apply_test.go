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
	err := cli.DeleteByRelease(context.Background(), "default", "rel-1")
	require.NoError(t, err, "forbidden/not-found on individual resources must not fail the whole delete")
}

func TestDeleteByRelease_SurfacesOtherErrors(t *testing.T) {
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClient(scheme)

	dyn.PrependReactor("delete-collection", "deployments", func(action clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("boom")
	})

	cli := k8s.NewForTest(dyn)
	err := cli.DeleteByRelease(context.Background(), "default", "rel-1")
	require.Error(t, err)
	require.Contains(t, err.Error(), "boom")
}
