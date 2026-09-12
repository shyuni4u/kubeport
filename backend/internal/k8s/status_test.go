package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgotesting "k8s.io/client-go/testing"

	"kubeport/internal/k8s"
)

// pod is a pod of release in the demo namespace with the given status.
func pod(name, release string, status map[string]any) *unstructured.Unstructured {
	u := existing("v1", "Pod", "demo", name, release)
	u.Object["status"] = status
	return u
}

func waiting(reason, message string) map[string]any {
	return map[string]any{"waiting": map[string]any{"reason": reason, "message": message}}
}

func TestListInstances_ReportsWhyAPodIsNotRunning(t *testing.T) {
	cases := map[string]struct {
		status      map[string]any
		wantReason  string
		wantMessage string
	}{
		"image cannot be pulled": {
			status: map[string]any{
				"phase": "Pending",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0),
					"state": waiting("ImagePullBackOff", `Back-off pulling image "ghcr.io/does-not-exist/nightly:0.0.0"`),
				}},
			},
			wantReason:  "ImagePullBackOff",
			wantMessage: `Back-off pulling image "ghcr.io/does-not-exist/nightly:0.0.0"`,
		},
		"crash loop says how it last ended": {
			status: map[string]any{
				"phase": "Running",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(4),
					"state":     waiting("CrashLoopBackOff", "back-off 40s restarting failed container"),
					"lastState": map[string]any{"terminated": map[string]any{"reason": "Error", "exitCode": int64(1)}},
				}},
			},
			wantReason:  "CrashLoopBackOff",
			wantMessage: "Error, exit code 1",
		},
		"crash loop from running out of memory is OOMKilled": {
			status: map[string]any{
				"phase": "Running",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(2),
					"state":     waiting("CrashLoopBackOff", "back-off 20s restarting failed container"),
					"lastState": map[string]any{"terminated": map[string]any{"reason": "OOMKilled", "exitCode": int64(137)}},
				}},
			},
			wantReason:  "OOMKilled",
			wantMessage: "OOMKilled, exit code 137",
		},
		"init container blocks the rest": {
			status: map[string]any{
				"phase": "Pending",
				"initContainerStatuses": []any{map[string]any{
					"name": "migrate", "restartCount": int64(0),
					"state": waiting("ErrImagePull", "manifest unknown"),
				}},
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0),
					"state": waiting("PodInitializing", ""),
				}},
			},
			wantReason:  "ErrImagePull",
			wantMessage: "manifest unknown",
		},
		"not schedulable": {
			status: map[string]any{
				"phase": "Pending",
				"conditions": []any{map[string]any{
					"type": "PodScheduled", "status": "False",
					"reason": "Unschedulable", "message": "0/1 nodes are available: 1 Insufficient cpu.",
				}},
			},
			wantReason:  "Unschedulable",
			wantMessage: "0/1 nodes are available: 1 Insufficient cpu.",
		},
		"evicted": {
			status: map[string]any{
				"phase": "Failed", "reason": "Evicted", "message": "The node was low on resource: memory.",
			},
			wantReason:  "Evicted",
			wantMessage: "The node was low on resource: memory.",
		},
		// The kubelet kills an evicted pod's containers, so they report Error
		// with exit code 137. Naming that would tell the reader the app keeps
		// crashing and to change its settings, when the node ran short.
		"evicted with its containers killed is still evicted": {
			status: map[string]any{
				"phase": "Failed", "reason": "Evicted", "message": "The node was low on resource: memory.",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0),
					"state": map[string]any{"terminated": map[string]any{"reason": "Error", "exitCode": int64(137)}},
				}},
			},
			wantReason:  "Evicted",
			wantMessage: "The node was low on resource: memory.",
		},
		"still being created is not a problem yet": {
			status: map[string]any{
				"phase": "Pending",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0), "state": waiting("ContainerCreating", ""),
				}},
			},
		},
		"a job that finished is not a problem": {
			status: map[string]any{
				"phase": "Succeeded",
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0),
					"state": map[string]any{"terminated": map[string]any{"reason": "Completed", "exitCode": int64(0)}},
				}},
			},
		},
		"running and ready": {
			status: map[string]any{
				"phase":      "Running",
				"conditions": []any{map[string]any{"type": "Ready", "status": "True"}},
				"containerStatuses": []any{map[string]any{
					"name": "app", "restartCount": int64(0), "state": map[string]any{"running": map[string]any{}},
				}},
			},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			cli := k8s.NewForTest(cluster(pod("p-1", "rel", tc.status)))
			got, err := cli.ListInstances(context.Background(), nameOnlyRef("rel"))
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Equal(t, tc.wantReason, got[0].Reason)
			require.Equal(t, tc.wantMessage, got[0].Message)
		})
	}
}

// withUID returns p with the release id label set.
func withUID(p *unstructured.Unstructured, uid string) *unstructured.Unstructured {
	labels := p.GetLabels()
	labels[k8s.ReleaseUIDLabel] = uid
	p.SetLabels(labels)
	return p
}

// ownedByJob returns p as a pod created by the Job with this name and uid.
func ownedByJob(p *unstructured.Unstructured, job, jobUID string) *unstructured.Unstructured {
	p.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: job, UID: types.UID(jobUID)}})
	return p
}

// withObjectUID sets the object's own metadata.uid, as the apiserver would.
func withObjectUID(u *unstructured.Unstructured, uid string) *unstructured.Unstructured {
	u.SetUID(types.UID(uid))
	return u
}

func instanceNames(t *testing.T, got []k8s.Instance, err error) []string {
	t.Helper()
	require.NoError(t, err)
	names := make([]string, 0, len(got))
	for _, ins := range got {
		names = append(names, ins.Name)
	}
	return names
}

// #195: a pod carrying this release's name under another release's id belongs
// to that release. An unstamped pod counts only for a release from before the
// id existed (NameOnly) — for one created since, it is an earlier release's.
func TestListInstances_CountsPodsByIDAndUnstampedOnesOnlyForANameOnlyRelease(t *testing.T) {
	running := map[string]any{"phase": "Running"}
	objs := func() []runtime.Object {
		return []runtime.Object{
			withUID(pod("p-mine", "rel", running), uidMine),
			withUID(pod("p-theirs", "rel", running), uidOther),
			pod("p-old", "rel", running),
		}
	}

	got, err := k8s.NewForTest(cluster(objs()...)).ListInstances(context.Background(), nameOnlyRef("rel"))
	require.ElementsMatch(t, []string{"p-mine", "p-old"}, instanceNames(t, got, err))

	got, err = k8s.NewForTest(cluster(objs()...)).ListInstances(context.Background(), relRef("rel"))
	require.ElementsMatch(t, []string{"p-mine"}, instanceNames(t, got, err))
}

// Security review of #195: a Job's pods carry no id (the Job's pod template is
// immutable), so they count through the Job that created them. A Job pod whose
// Job is gone — orphaned by a delete — or is another release's does not.
func TestListInstances_CountsAJobsPodsThroughTheJob(t *testing.T) {
	running := map[string]any{"phase": "Running"}
	myJob := withObjectUID(stamped("batch/v1", "Job", "demo", "once", "rel", uidMine), "job-once-now")
	theirJob := withObjectUID(stamped("batch/v1", "Job", "demo", "theirs", "rel", uidOther), "job-theirs")

	got, err := k8s.NewForTest(cluster(
		myJob, theirJob,
		ownedByJob(pod("once-abcde", "rel", running), "once", "job-once-now"),
		ownedByJob(pod("theirs-fghij", "rel", running), "theirs", "job-theirs"),
		ownedByJob(pod("gone-klmno", "rel", running), "gone", "job-gone"),
		// codex review: orphaned from an earlier Job that was also called
		// "once". The name matches this release's Job; the uid does not.
		ownedByJob(pod("once-older", "rel", running), "once", "job-once-before"),
	)).ListInstances(context.Background(), relRef("rel"))

	require.ElementsMatch(t, []string{"once-abcde"}, instanceNames(t, got, err))
}

// ownedBy returns u as created by the controller of this kind, name and uid.
func ownedBy(u *unstructured.Unstructured, apiVersion, kind, name, uid string) *unstructured.Unstructured {
	u.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: apiVersion, Kind: kind, Name: name, UID: types.UID(uid)}})
	return u
}

// codex review, round 5: the first update of a release from before the id
// stamps its workloads, but not every pod they run is replaced — a StatefulSet
// or DaemonSet updating OnDelete keeps its pods, and a Deployment whose rollout
// has not finished keeps the old ReplicaSet's. Those count through their
// controller, by uid: the StatefulSet, or the ReplicaSet's Deployment.
func TestListInstances_CountsUnstampedPodsThroughTheirWorkload(t *testing.T) {
	running := map[string]any{"phase": "Running"}
	db := withObjectUID(stamped("apps/v1", "StatefulSet", "demo", "db", "rel", uidMine), "sts-db")
	theirs := withObjectUID(stamped("apps/v1", "StatefulSet", "demo", "cache", "rel", uidOther), "sts-cache")
	web := withObjectUID(stamped("apps/v1", "Deployment", "demo", "web", "rel", uidMine), "deploy-web")
	oldRS := withObjectUID(ownedBy(existing("apps/v1", "ReplicaSet", "demo", "web-old", "rel"),
		"apps/v1", "Deployment", "web", "deploy-web"), "rs-web-old")

	got, err := k8s.NewForTest(cluster(
		db, theirs, web, oldRS,
		ownedBy(pod("db-0", "rel", running), "apps/v1", "StatefulSet", "db", "sts-db"),
		ownedBy(pod("cache-0", "rel", running), "apps/v1", "StatefulSet", "cache", "sts-cache"),
		ownedBy(pod("web-old-abcde", "rel", running), "apps/v1", "ReplicaSet", "web-old", "rs-web-old"),
		ownedBy(pod("web-gone-fghij", "rel", running), "apps/v1", "ReplicaSet", "web-gone", "rs-web-gone"),
	)).ListInstances(context.Background(), relRef("rel"))

	require.ElementsMatch(t, []string{"db-0", "web-old-abcde"}, instanceNames(t, got, err))
}

// codex review, round 5: a controller that could not be read is not one that
// is someone else's. The error surfaces as it does for the pod list itself,
// instead of the release showing no pods.
func TestListInstances_SurfacesAControllerThatCannotBeRead(t *testing.T) {
	running := map[string]any{"phase": "Running"}
	for name, fail := range map[string]func(*dynamicfake.FakeDynamicClient){
		"forbidden": func(dyn *dynamicfake.FakeDynamicClient) { forbidGet(dyn, "jobs") },
		"unreachable": func(dyn *dynamicfake.FakeDynamicClient) {
			dyn.PrependReactor("get", "jobs", func(clientgotesting.Action) (bool, runtime.Object, error) {
				return true, nil, errors.New("connection reset")
			})
		},
	} {
		t.Run(name, func(t *testing.T) {
			dyn := cluster(
				withObjectUID(stamped("batch/v1", "Job", "demo", "once", "rel", uidMine), "job-once"),
				ownedByJob(pod("once-abcde", "rel", running), "once", "job-once"),
			)
			fail(dyn)

			_, err := k8s.NewForTest(dyn).ListInstances(context.Background(), relRef("rel"))

			require.Error(t, err)
		})
	}
}

const nightly = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
`

const configAndSecret = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secret
`

func TestReleasePresence(t *testing.T) {
	t.Run("a cronjob between runs is still there", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(existing("batch/v1", "CronJob", "demo", "nightly", "nightly-job-demo")))
		got, err := cli.ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceFound, got)
	})

	t.Run("gone", func(t *testing.T) {
		cli := k8s.NewForTest(cluster())
		got, err := cli.ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an object now held by another release is not this one's", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(existing("batch/v1", "CronJob", "demo", "nightly", "someone-else")))
		got, err := cli.ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an object with this name and another release's id is not this one's (#195)", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(stamped("batch/v1", "CronJob", "demo", "nightly", "nightly-job-demo", uidOther)))
		got, err := cli.ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an object with this release's id is found", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(stamped("batch/v1", "CronJob", "demo", "nightly", "nightly-job-demo", uidMine)))
		got, err := cli.ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceFound, got)
	})

	t.Run("an unstamped object is not a stamped release's (#195)", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(existing("batch/v1", "CronJob", "demo", "nightly", "nightly-job-demo")))
		got, err := cli.ReleasePresence(context.Background(), relRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("nothing readable says nothing", func(t *testing.T) {
		dyn := cluster()
		forbidGet(dyn, "cronjobs")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceUnknown, got)
	})

	t.Run("an unreadable secret does not hide a readable absence", func(t *testing.T) {
		dyn := cluster()
		forbidGet(dyn, "secrets")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), nameOnlyRef("cfg-demo"), []byte(configAndSecret))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an unreadable secret next to a present configmap is found", func(t *testing.T) {
		dyn := cluster(existing("v1", "ConfigMap", "demo", "app-config", "cfg-demo"))
		forbidGet(dyn, "secrets")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), nameOnlyRef("cfg-demo"), []byte(configAndSecret))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceFound, got)
	})

	t.Run("an apiserver error is an error, not an absence", func(t *testing.T) {
		dyn := cluster()
		dyn.PrependReactor("get", "cronjobs", func(clientgotesting.Action) (bool, runtime.Object, error) {
			return true, nil, errors.New("connection reset")
		})
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), nameOnlyRef("nightly-job-demo"), []byte(nightly))
		require.Error(t, err)
		require.Equal(t, k8s.PresenceUnknown, got)
	})
}
