package k8s

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Instance represents the runtime state of a single Pod.
type Instance struct {
	Name     string `json:"name"`
	Phase    string `json:"phase"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts"`
	// Reason is why the pod is not running normally, in the kubelet's or the
	// scheduler's own word — ImagePullBackOff, CrashLoopBackOff, OOMKilled,
	// Unschedulable, Evicted — or "" when there is nothing to explain. Phase
	// cannot say it: a pod that will never pull its image stays "Pending", the
	// same word as one a second away from starting (#33).
	Reason string `json:"reason,omitempty"`
	// Message is the detail k8s attached to Reason, verbatim and untranslated.
	Message string `json:"message,omitempty"`
}

// ListInstances returns pod status for all pods matching the release label.
func (c *Client) ListInstances(ctx context.Context, namespace, release string) ([]Instance, error) {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	list, err := c.dyn.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: ReleaseLabel + "=" + release,
	})
	if err != nil {
		return nil, err
	}
	out := make([]Instance, 0, len(list.Items))
	for _, p := range list.Items {
		ins := Instance{Name: p.GetName()}
		if status, ok := p.Object["status"].(map[string]any); ok {
			if phase, ok := status["phase"].(string); ok {
				ins.Phase = phase
			}
			ins.Ready = allContainersReady(status)
			ins.Restarts = totalRestarts(status)
			ins.Reason, ins.Message = podProblem(status)
		}
		out = append(out, ins)
	}
	return out, nil
}

// allContainersReady returns true if every container in the pod reports ready.
func allContainersReady(status map[string]any) bool {
	conditions, ok := status["conditions"].([]any)
	if !ok {
		return false
	}
	for _, c := range conditions {
		cond, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if cond["type"] == "Ready" {
			return cond["status"] == "True"
		}
	}
	return false
}

// totalRestarts sums restartCount across container and init container statuses.
func totalRestarts(status map[string]any) int32 {
	var total int32
	for _, key := range []string{"containerStatuses", "initContainerStatuses"} {
		statuses, ok := status[key].([]any)
		if !ok {
			continue
		}
		for _, s := range statuses {
			cs, ok := s.(map[string]any)
			if !ok {
				continue
			}
			if rc, ok := asInt64(cs["restartCount"]); ok {
				total += int32(rc)
			}
		}
	}
	return total
}

// podProblem picks the one reason worth showing for a pod that is not running
// normally. A pod-level reason (Evicted) comes first: the kubelet kills the
// containers of a pod it evicts, and they report Error with exit code 137 —
// naming that would send the reader to fix a crash that never happened.
// Init containers come next, because a pod whose init container cannot start
// never gets as far as the rest. The scheduler's condition comes last: a
// container that has a state at all was scheduled, and its state is the
// nearer cause.
func podProblem(status map[string]any) (reason, message string) {
	if r, _ := status["reason"].(string); r != "" {
		m, _ := status["message"].(string)
		return r, m
	}
	for _, key := range []string{"initContainerStatuses", "containerStatuses"} {
		statuses, _ := status[key].([]any)
		for _, s := range statuses {
			cs, ok := s.(map[string]any)
			if !ok {
				continue
			}
			if r, m := containerProblem(cs); r != "" {
				return r, m
			}
		}
	}
	conditions, _ := status["conditions"].([]any)
	for _, c := range conditions {
		cond, ok := c.(map[string]any)
		if !ok || cond["type"] != "PodScheduled" || cond["status"] != "False" {
			continue
		}
		if r, _ := cond["reason"].(string); r != "" {
			m, _ := cond["message"].(string)
			return r, m
		}
	}
	return "", ""
}

// containerProblem reads one container status. A container still being
// created is not a problem yet, and one that ran to completion is not one at
// all. For CrashLoopBackOff the waiting message only says a back-off is under
// way; how the container last ended is what explains it, so that is what the
// message carries — and when it ended by running out of memory, that becomes
// the reason, because it is the one with a different fix.
func containerProblem(cs map[string]any) (string, string) {
	state, _ := cs["state"].(map[string]any)
	if w, ok := state["waiting"].(map[string]any); ok {
		r, _ := w["reason"].(string)
		m, _ := w["message"].(string)
		switch r {
		case "", "ContainerCreating", "PodInitializing":
			return "", ""
		case "CrashLoopBackOff":
			last, _ := cs["lastState"].(map[string]any)
			if t, ok := last["terminated"].(map[string]any); ok {
				if lr, _ := t["reason"].(string); lr == "OOMKilled" {
					return lr, terminationMessage(t)
				}
				return r, terminationMessage(t)
			}
		}
		return r, m
	}
	if t, ok := state["terminated"].(map[string]any); ok {
		if r, _ := t["reason"].(string); r != "" && r != "Completed" {
			return r, terminationMessage(t)
		}
	}
	return "", ""
}

// terminationMessage renders a terminated container state as
// "Error, exit code 1: <message>".
func terminationMessage(t map[string]any) string {
	r, _ := t["reason"].(string)
	out := r
	if code, ok := asInt64(t["exitCode"]); ok {
		out = fmt.Sprintf("%s, exit code %d", r, code)
	}
	if m, _ := t["message"].(string); m != "" {
		out += ": " + m
	}
	return out
}

// asInt64 reads a JSON number from an unstructured object: int64 when it came
// from the apiserver, float64 when it went through encoding/json into an any.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		return int64(n), true
	}
	return 0, false
}

// Presence is what a release's rendered objects look like in the cluster.
type Presence int

const (
	// PresenceUnknown means nothing could be read, so nothing can be said.
	// The demo user Role withholds get on Secrets, and a template may render
	// only kinds its caller cannot read.
	PresenceUnknown Presence = iota
	// PresenceFound means at least one object still carries the release's label.
	PresenceFound
	// PresenceMissing means every object the caller could read is gone, or
	// now belongs to something else.
	PresenceMissing
)

// ReleasePresence reports whether the objects a release rendered are still in
// the cluster. A release with no pods is not necessarily one whose objects are
// gone: a CronJob between runs has none, and so does a Deployment scaled to
// zero. Counting pods alone called both "resources missing", and the banner
// that goes with it told the reader they had been deleted outside kubeport
// (#33, #8).
//
// Objects are looked up in the release's namespace: one that pins another is
// refused before it is ever applied (#137).
func (c *Client) ReleasePresence(ctx context.Context, namespace, release string, multiDoc []byte) (Presence, error) {
	objs, err := splitYAML(multiDoc)
	if err != nil {
		return PresenceUnknown, fmt.Errorf("split yaml: %w", err)
	}
	readable := false
	for _, o := range objs {
		if err := ctx.Err(); err != nil {
			return PresenceUnknown, err
		}
		gvk := o.GroupVersionKind()
		plural := pluralize(gvk.Kind)
		if plural == "" || o.GetName() == "" {
			continue
		}
		gvr := schema.GroupVersionResource{Group: gvk.Group, Version: gvk.Version, Resource: plural}
		got, err := c.dyn.Resource(gvr).Namespace(namespace).Get(ctx, o.GetName(), metav1.GetOptions{})
		switch {
		case err == nil:
			readable = true
			if got.GetLabels()[ReleaseLabel] == release {
				return PresenceFound, nil
			}
		case apierrors.IsNotFound(err):
			readable = true
		case apierrors.IsForbidden(err):
			// Says nothing either way.
		default:
			return PresenceUnknown, fmt.Errorf("get %s/%s: %w", gvk.Kind, o.GetName(), err)
		}
	}
	if !readable {
		return PresenceUnknown, nil
	}
	return PresenceMissing, nil
}
