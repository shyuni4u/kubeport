package k8s

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Instance represents the runtime state of a single Pod.
type Instance struct {
	Name     string `json:"name"`
	Phase    string `json:"phase"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts"`
}

// ListInstances returns pod status for all pods matching the release label.
func (c *Client) ListInstances(ctx context.Context, namespace, release string) ([]Instance, error) {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	list, err := c.dyn.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "kubeport.io/release=" + release,
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
			if rc, ok := cs["restartCount"].(int64); ok {
				total += int32(rc)
			} else if rc, ok := cs["restartCount"].(float64); ok {
				total += int32(rc)
			}
		}
	}
	return total
}
