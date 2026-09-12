package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgotesting "k8s.io/client-go/testing"

	"kubeport/internal/k8s"
)

const previousManifest = `apiVersion: v1
kind: ConfigMap
metadata:
  name: dropped
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: foreign
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: taken
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gone
---
apiVersion: v1
kind: Secret
metadata:
  name: unreadable
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
`

const nextManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
`

// migrationCluster is cluster with every kind kubeport manages listable, as
// StampLeftBehind lists them all.
func migrationCluster(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			{Group: "apps", Version: "v1", Resource: "deployments"}:            "DeploymentList",
			{Group: "apps", Version: "v1", Resource: "statefulsets"}:           "StatefulSetList",
			{Group: "apps", Version: "v1", Resource: "daemonsets"}:             "DaemonSetList",
			{Group: "batch", Version: "v1", Resource: "jobs"}:                  "JobList",
			{Group: "batch", Version: "v1", Resource: "cronjobs"}:              "CronJobList",
			{Version: "v1", Resource: "services"}:                              "ServiceList",
			{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}: "IngressList",
			{Version: "v1", Resource: "configmaps"}:                            "ConfigMapList",
			{Version: "v1", Resource: "secrets"}:                               "SecretList",
			{Version: "v1", Resource: "persistentvolumeclaims"}:                "PersistentVolumeClaimList",
		}, objs...)
}

// patchRefused is the apiserver's answer to a JSON patch it could not apply,
// as a v1.35 apiserver sent it for a failed test op: 422, no details.
var patchRefused = &apierrors.StatusError{ErrStatus: metav1.Status{
	Status:  metav1.StatusFailure,
	Code:    422,
	Reason:  metav1.StatusReasonInvalid,
	Message: "the server rejected our request due to an error in our request",
}}

// asAPIServer answers patches as an apiserver does, and records each one
// applied as resource/name. The fake tracker applies a JSON patch with the
// same json-patch library, but returns a failed test op as a bare error where
// the apiserver answers patchRefused.
func asAPIServer(dyn *dynamicfake.FakeDynamicClient) *[]string {
	var applied []string
	tracker := clientgotesting.ObjectReaction(dyn.Tracker())
	dyn.PrependReactor("patch", "*", func(a clientgotesting.Action) (bool, runtime.Object, error) {
		handled, obj, err := tracker(a)
		var status apierrors.APIStatus
		if err != nil && !errors.As(err, &status) {
			err = patchRefused
		}
		if err == nil {
			applied = append(applied, a.GetResource().Resource+"/"+a.(clientgotesting.PatchActionImpl).Name)
		}
		return handled, obj, err
	})
	return &applied
}

func forbidList(dyn *dynamicfake.FakeDynamicClient, resource string) {
	dyn.PrependReactor("list", resource, func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: resource}, "", errors.New("the role withholds list"))
	})
}

func labelsOf(t *testing.T, dyn *dynamicfake.FakeDynamicClient, resource, name string) map[string]string {
	t.Helper()
	got, err := dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: resource}).
		Namespace("demo").Get(context.Background(), name, metav1.GetOptions{})
	require.NoError(t, err)
	return got.GetLabels()
}

// codex review of #195: the first update of a release from before the id must
// stamp every object the release still owns by name alone and will not apply
// — one the new version drops, and one an update before #195 already dropped,
// which no manifest names. Another release's objects are not touched.
func TestStampLeftBehind_StampsWhatTheReleaseOwnsByNameAlone(t *testing.T) {
	dyn := migrationCluster(
		existing("v1", "ConfigMap", "demo", "dropped", "web-app"),
		existing("v1", "ConfigMap", "demo", "dropped-before-195", "web-app"),
		existing("v1", "ConfigMap", "demo", "foreign", "someone-else"),
		stamped("v1", "ConfigMap", "demo", "taken", "web-app", uidOther),
		existing("v1", "Secret", "demo", "unreadable", "web-app"),
		existing("v1", "Secret", "demo", "unlisted-before-195", "web-app"),
		existing("apps/v1", "Deployment", "demo", "web", "web-app"),
	)
	forbidList(dyn, "secrets")
	applied := asAPIServer(dyn)
	ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

	err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previousManifest), []byte(nextManifest))

	require.NoError(t, err)
	require.ElementsMatch(t, []string{
		"deployments/web",               // found by the selector; the update applies it anyway
		"configmaps/dropped",            // dropped by this update
		"configmaps/dropped-before-195", // no manifest names it: only the selector finds it
		"secrets/unreadable",            // not listable: found by the previous manifest
	}, *applied)

	require.Equal(t, map[string]string{k8s.ReleaseLabel: "web-app", k8s.ReleaseUIDLabel: uidMine},
		labelsOf(t, dyn, "configmaps", "dropped-before-195"), "the patch adds the id and keeps the name")
	require.Equal(t, uidOther, labelsOf(t, dyn, "configmaps", "taken")[k8s.ReleaseUIDLabel])
	require.NotContains(t, labelsOf(t, dyn, "configmaps", "foreign"), k8s.ReleaseUIDLabel)
	require.NotContains(t, labelsOf(t, dyn, "secrets", "unlisted-before-195"), k8s.ReleaseUIDLabel,
		"a known limit: neither listable nor named by the previous manifest")
}

// codex review, round 4: the patch for an object the caller cannot read used
// to add the id over one already there, handing this release another's
// Secret. Its test ops now require the name and no id, so the apiserver
// refuses it for an object with another name or with any id.
func TestStampLeftBehind_NeverTakesAnObjectThatIsNotThisReleasesByName(t *testing.T) {
	dyn := migrationCluster(
		stamped("v1", "Secret", "demo", "unreadable", "web-app", uidOther),
		existing("v1", "Secret", "demo", "renamed", "someone-else"),
	)
	forbidList(dyn, "secrets")
	applied := asAPIServer(dyn)
	var bodies []string
	dyn.PrependReactor("patch", "secrets", func(a clientgotesting.Action) (bool, runtime.Object, error) {
		bodies = append(bodies, string(a.(clientgotesting.PatchActionImpl).Patch))
		return false, nil, nil
	})
	previous := previousManifest + `---
apiVersion: v1
kind: Secret
metadata:
  name: renamed
`
	ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

	err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previous), []byte(nextManifest))

	require.NoError(t, err, "a refused patch is a verdict, not an error")
	require.Empty(t, *applied)
	require.Equal(t, uidOther, labelsOf(t, dyn, "secrets", "unreadable")[k8s.ReleaseUIDLabel])
	require.NotContains(t, labelsOf(t, dyn, "secrets", "renamed"), k8s.ReleaseUIDLabel)
	require.Len(t, bodies, 2)
	require.Contains(t, bodies[0], `{"op":"test","path":"/metadata/labels/kubeport.io~1release","value":"web-app"}`)
	require.Contains(t, bodies[0], `{"op":"test","path":"/metadata/labels/kubeport.io~1release-uid","value":null}`)
	require.Contains(t, bodies[0], `{"op":"add","path":"/metadata/labels/kubeport.io~1release-uid","value":"`+uidMine+`"}`)
}

// An apiserver error is not a verdict: the caller must not drop the fallback
// with objects still unstamped.
func TestStampLeftBehind_SurfacesOtherErrors(t *testing.T) {
	for name, fail := range map[string]func(*dynamicfake.FakeDynamicClient){
		"list": func(dyn *dynamicfake.FakeDynamicClient) {
			dyn.PrependReactor("list", "configmaps", func(clientgotesting.Action) (bool, runtime.Object, error) {
				return true, nil, errors.New("connection reset")
			})
		},
		"patch": func(dyn *dynamicfake.FakeDynamicClient) {
			forbidList(dyn, "configmaps")
			dyn.PrependReactor("patch", "configmaps", func(clientgotesting.Action) (bool, runtime.Object, error) {
				return true, nil, errors.New("connection reset")
			})
		},
		// Security review: a 422 that is not a failed test op — the object
		// failing validation, or an admission policy — names the object. It
		// is not a verdict, and skipping it would leave the object unstamped.
		"an invalid object": func(dyn *dynamicfake.FakeDynamicClient) {
			forbidList(dyn, "configmaps")
			dyn.PrependReactor("patch", "configmaps", func(clientgotesting.Action) (bool, runtime.Object, error) {
				return true, nil, apierrors.NewInvalid(schema.GroupKind{Kind: "ConfigMap"}, "dropped", nil)
			})
		},
		// Security review: an admission webhook's 422 carries no details.
		"a webhook's refusal": func(dyn *dynamicfake.FakeDynamicClient) {
			forbidList(dyn, "configmaps")
			dyn.PrependReactor("patch", "configmaps", func(clientgotesting.Action) (bool, runtime.Object, error) {
				return true, nil, &apierrors.StatusError{ErrStatus: metav1.Status{
					Status:  metav1.StatusFailure,
					Code:    422,
					Reason:  metav1.StatusReasonInvalid,
					Message: `admission webhook "labels.example.com" denied the request: no`,
				}}
			})
		},
	} {
		t.Run(name, func(t *testing.T) {
			dyn := migrationCluster(existing("v1", "ConfigMap", "demo", "dropped", "web-app"))
			fail(dyn)
			ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

			err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previousManifest), []byte(nextManifest))

			require.ErrorContains(t, err, "configmaps")
		})
	}
}
