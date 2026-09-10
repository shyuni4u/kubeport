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

// codex review of #195: the first update of a release from before the id drops
// an object. Unless it is stamped, the release — no longer NameOnly — would
// leave it behind on delete. Only what is still this release's by name is
// stamped; what the update applies anyway is not touched here.
func TestStampLeftBehind_StampsWhatTheNewVersionDropped(t *testing.T) {
	dyn := cluster(
		existing("v1", "ConfigMap", "demo", "dropped", "web-app"),
		existing("v1", "ConfigMap", "demo", "foreign", "someone-else"),
		stamped("v1", "ConfigMap", "demo", "taken", "web-app", uidOther),
		existing("v1", "Secret", "demo", "unreadable", "web-app"),
		existing("apps/v1", "Deployment", "demo", "web", "web-app"),
	)
	forbidGet(dyn, "secrets")
	var patched []string
	var secretPatch string
	dyn.PrependReactor("patch", "*", func(a clientgotesting.Action) (bool, runtime.Object, error) {
		pa := a.(clientgotesting.PatchActionImpl)
		patched = append(patched, a.GetResource().Resource+"/"+pa.Name+":"+string(pa.PatchType))
		if a.GetResource().Resource == "secrets" {
			secretPatch = string(pa.Patch)
			return true, nil, nil
		}
		return false, nil, nil
	})
	ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

	err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previousManifest), []byte(nextManifest))

	require.NoError(t, err)
	require.Equal(t, []string{
		"configmaps/dropped:application/merge-patch+json",
		"secrets/unreadable:application/json-patch+json",
	}, patched, "not the Deployment the update applies, another release's objects, or a gone one")
	// Security review: an object the caller cannot read is stamped only through
	// a patch the apiserver refuses unless it carries this release's name.
	require.Contains(t, secretPatch, `"op":"test","path":"/metadata/labels/kubeport.io~1release","value":"web-app"`)
	require.Contains(t, secretPatch, `"op":"add","path":"/metadata/labels/kubeport.io~1release-uid","value":"`+uidMine+`"`)

	got, err := dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}).
		Namespace("demo").Get(context.Background(), "dropped", metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, uidMine, got.GetLabels()[k8s.ReleaseUIDLabel])
	require.Equal(t, "web-app", got.GetLabels()[k8s.ReleaseLabel], "the patch adds the id and keeps the name")
}

// The guarded patch's test op failing means the unreadable object carries
// another name: not this release's, and not an error.
func TestStampLeftBehind_AnUnreadableObjectWithAnotherNameIsLeftAlone(t *testing.T) {
	dyn := cluster(existing("v1", "Secret", "demo", "unreadable", "someone-else"))
	forbidGet(dyn, "secrets")
	dyn.PrependReactor("patch", "secrets", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewInvalid(schema.GroupKind{Kind: "Secret"}, "unreadable", nil)
	})
	ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

	err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previousManifest), []byte(nextManifest))

	require.NoError(t, err)
}

// An apiserver error is not a verdict: the caller must not drop the fallback
// with objects still unstamped.
func TestStampLeftBehind_SurfacesOtherErrors(t *testing.T) {
	dyn := cluster(existing("v1", "ConfigMap", "demo", "dropped", "web-app"))
	dyn.PrependReactor("get", "configmaps", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection reset")
	})
	ref := k8s.ReleaseRef{Namespace: "demo", Name: "web-app", UID: uidMine, NameOnly: true}

	err := k8s.NewForTest(dyn).StampLeftBehind(context.Background(), ref, []byte(previousManifest), []byte(nextManifest))

	require.ErrorContains(t, err, "connection reset")
}
