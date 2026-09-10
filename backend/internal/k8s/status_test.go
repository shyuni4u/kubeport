package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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
			got, err := cli.ListInstances(context.Background(), "demo", "rel")
			require.NoError(t, err)
			require.Len(t, got, 1)
			require.Equal(t, tc.wantReason, got[0].Reason)
			require.Equal(t, tc.wantMessage, got[0].Message)
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
		got, err := cli.ReleasePresence(context.Background(), "demo", "nightly-job-demo", []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceFound, got)
	})

	t.Run("gone", func(t *testing.T) {
		cli := k8s.NewForTest(cluster())
		got, err := cli.ReleasePresence(context.Background(), "demo", "nightly-job-demo", []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an object now held by another release is not this one's", func(t *testing.T) {
		cli := k8s.NewForTest(cluster(existing("batch/v1", "CronJob", "demo", "nightly", "someone-else")))
		got, err := cli.ReleasePresence(context.Background(), "demo", "nightly-job-demo", []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("nothing readable says nothing", func(t *testing.T) {
		dyn := cluster()
		forbidGet(dyn, "cronjobs")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), "demo", "nightly-job-demo", []byte(nightly))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceUnknown, got)
	})

	t.Run("an unreadable secret does not hide a readable absence", func(t *testing.T) {
		dyn := cluster()
		forbidGet(dyn, "secrets")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), "demo", "cfg-demo", []byte(configAndSecret))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceMissing, got)
	})

	t.Run("an unreadable secret next to a present configmap is found", func(t *testing.T) {
		dyn := cluster(existing("v1", "ConfigMap", "demo", "app-config", "cfg-demo"))
		forbidGet(dyn, "secrets")
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), "demo", "cfg-demo", []byte(configAndSecret))
		require.NoError(t, err)
		require.Equal(t, k8s.PresenceFound, got)
	})

	t.Run("an apiserver error is an error, not an absence", func(t *testing.T) {
		dyn := cluster()
		dyn.PrependReactor("get", "cronjobs", func(clientgotesting.Action) (bool, runtime.Object, error) {
			return true, nil, errors.New("connection reset")
		})
		got, err := k8s.NewForTest(dyn).ReleasePresence(context.Background(), "demo", "nightly-job-demo", []byte(nightly))
		require.Error(t, err)
		require.Equal(t, k8s.PresenceUnknown, got)
	})
}
