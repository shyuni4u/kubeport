package k8s_test

import (
	"testing"

	"github.com/stretchr/testify/require"

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
