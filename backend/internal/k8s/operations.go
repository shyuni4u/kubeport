package k8s

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	apps "k8s.io/api/apps/v1"
	core "k8s.io/api/core/v1"
	networking "k8s.io/api/networking/v1"
	policy "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
)

// Foundations are opt-in annotations on actual cluster resources. Only a
// principal who can patch the class can publish them; app roles grant no RBAC.
const FoundationAnnotation = "kubeport.io/self-service"

type Foundation struct {
	Namespace string `json:"namespace"`
	Domain    string `json:"domain,omitempty"`
	TLSSecret string `json:"tls_secret,omitempty"`
	MaxGi     int64  `json:"max_gi,omitempty"`
}

type OperationItem struct {
	Kind       string      `json:"kind"`
	Name       string      `json:"name"`
	Namespace  string      `json:"namespace,omitempty"`
	UID        string      `json:"uid,omitempty"`
	Version    string      `json:"version,omitempty"`
	Status     string      `json:"status"`
	Details    []string    `json:"details"`
	Foundation *Foundation `json:"foundation,omitempty"`
}

type OperationSection struct {
	Resource  string          `json:"resource"`
	Items     []OperationItem `json:"items"`
	Error     string          `json:"error,omitempty"`
	Truncated bool            `json:"truncated,omitempty"`
}

type OperationSnapshot struct {
	Sections    []OperationSection `json:"sections"`
	Permissions map[string]bool    `json:"permissions"`
}

type OperationValidationError struct{ Message string }

func (e *OperationValidationError) Error() string { return e.Message }
func invalidOperation(format string, args ...any) error {
	return &OperationValidationError{Message: fmt.Sprintf(format, args...)}
}

type OperationRequest struct {
	Image      string      `json:"image"`
	Action     string      `json:"action"`
	Namespace  string      `json:"namespace"`
	Name       string      `json:"name"`
	Node       string      `json:"node"`
	UID        string      `json:"uid"`
	Version    string      `json:"version"`
	Class      string      `json:"class"`
	SizeGi     int64       `json:"size_gi"`
	Claim      string      `json:"claim"`
	MountPath  string      `json:"mount_path"`
	Container  string      `json:"container"`
	Host       string      `json:"host"`
	Path       string      `json:"path"`
	Service    string      `json:"service"`
	Port       int32       `json:"port"`
	Foundation *Foundation `json:"foundation"`
}

// OperationErrorCode deliberately omits addresses, raw resource specs and
// upstream messages. The UI can distinguish discovery, transport and RBAC.
func OperationErrorCode(err error) string {
	var cert *tls.CertificateVerificationError
	if errors.As(err, &cert) {
		return "tls-error"
	}
	switch {
	case apierrors.IsForbidden(err):
		return "forbidden"
	case apierrors.IsUnauthorized(err):
		return "unauthorized"
	case apierrors.IsNotFound(err):
		return "unsupported"
	case apierrors.IsTooManyRequests(err):
		return "retry"
	default:
		return "unreachable"
	}
}

func foundation(annotations map[string]string) *Foundation {
	var f Foundation
	if json.Unmarshal([]byte(annotations[FoundationAnnotation]), &f) != nil || len(validation.IsDNS1123Label(f.Namespace)) != 0 {
		return nil
	}
	return &f
}

func item(kind string, obj meta.Object, status string, details ...string) OperationItem {
	return OperationItem{Kind: kind, Name: obj.GetName(), Namespace: obj.GetNamespace(), UID: string(obj.GetUID()), Version: obj.GetResourceVersion(), Status: status, Details: details}
}

func (c *Client) InspectOperations(ctx context.Context, area, ns string) OperationSnapshot {
	out := OperationSnapshot{Sections: []OperationSection{}, Permissions: map[string]bool{}}
	opts := meta.ListOptions{Limit: 500}
	add := func(name string, items []OperationItem, continuation string, err error) {
		if items == nil {
			items = []OperationItem{}
		}
		s := OperationSection{Resource: name, Items: items, Truncated: continuation != ""}
		if err != nil {
			s.Error = OperationErrorCode(err)
		}
		out.Sections = append(out.Sections, s)
	}
	check := func(action, group, resource, verb string) {
		namespace := ns
		if resource == "nodes" || resource == "storageclasses" || resource == "ingressclasses" {
			namespace = ""
		}
		resource, subresource, _ := strings.Cut(resource, "/")
		r, err := c.CheckAccess(ctx, AccessCheck{Namespace: namespace, Group: group, Resource: resource, Subresource: subresource, Verb: verb})
		out.Permissions[action] = err == nil && r.Allowed
	}
	if area == "nodes" {
		nodes, err := c.cs.CoreV1().Nodes().List(ctx, opts)
		pods, pe := c.cs.CoreV1().Pods("").List(ctx, opts)
		var rows, podRows []OperationItem
		if err == nil {
			for _, n := range nodes.Items {
				state := "NotReady"
				for _, cond := range n.Status.Conditions {
					if cond.Type == core.NodeReady && cond.Status == core.ConditionTrue {
						state = "Ready"
					}
				}
				if n.Spec.Unschedulable {
					state += " / cordoned"
				}
				cpu, mem, lcpu, lmem, count := int64(0), int64(0), int64(0), int64(0), 0
				if pe == nil {
					for _, p := range pods.Items {
						if p.Spec.NodeName == n.Name && p.Status.Phase != core.PodSucceeded && p.Status.Phase != core.PodFailed {
							a, b, x, y := podAllocation(p)
							cpu += a
							mem += b
							lcpu += x
							lmem += y
							count++
						}
					}
				}
				details := []string{fmt.Sprintf("allocatable: CPU %dm / memory %dMi", n.Status.Allocatable.Cpu().MilliValue(), n.Status.Allocatable.Memory().Value()/1048576), fmt.Sprintf("requests: CPU %dm / memory %dMi; limits: CPU %dm / memory %dMi; pods: %d", cpu, mem/1048576, lcpu, lmem/1048576, count), fmt.Sprintf("taints: %v", n.Spec.Taints)}
				if pe != nil || (pods != nil && pods.Continue != "") {
					details = append(details, "Pod allocation incomplete; do not infer spare capacity")
				}
				rows = append(rows, item("Node", &n, state, details...))
			}
		}
		cont := ""
		if nodes != nil {
			cont = nodes.Continue
		}
		add("nodes", rows, cont, err)
		if pe == nil {
			for _, p := range pods.Items {
				state := string(p.Status.Phase)
				if p.DeletionTimestamp != nil {
					state = "Terminating"
				}
				podRows = append(podRows, item("Pod", &p, state, "node: "+p.Spec.NodeName, "eviction: "+evictionBlock(p), fmt.Sprintf("nodeSelector: %v; affinity: %t; topology constraints: %d", p.Spec.NodeSelector, p.Spec.Affinity != nil, len(p.Spec.TopologySpreadConstraints))))
			}
		}
		cont = ""
		if pods != nil {
			cont = pods.Continue
		}
		add("pods", podRows, cont, pe)
		pdbs, e := c.cs.PolicyV1().PodDisruptionBudgets("").List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = pdbs.Continue
			for _, p := range pdbs.Items {
				rows = append(rows, item("PodDisruptionBudget", &p, fmt.Sprintf("disruptionsAllowed: %d", p.Status.DisruptionsAllowed), fmt.Sprintf("selector: %v", p.Spec.Selector)))
			}
		}
		add("poddisruptionbudgets", rows, cont, e)
		metrics, e := c.dyn.Resource(schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}).List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = metrics.GetContinue()
			for _, m := range metrics.Items {
				usage, _ := m.Object["usage"].(map[string]any)
				rows = append(rows, item("NodeMetrics", &m, "usage", fmt.Sprintf("CPU: %v / memory: %v / timestamp: %v", usage["cpu"], usage["memory"], m.Object["timestamp"])))
			}
		}
		add("metrics", rows, cont, e)
		check("cordon", "", "nodes", "patch")
		check("evict", "", "pods/eviction", "create")
	}
	if area == "storage" {
		classes, e := c.cs.StorageV1().StorageClasses().List(ctx, opts)
		var rows []OperationItem
		cont := ""
		if e == nil {
			cont = classes.Continue
			for _, s := range classes.Items {
				r := item("StorageClass", &s, s.Provisioner, fmt.Sprintf("reclaim: %v / binding: %v", value(s.ReclaimPolicy), value(s.VolumeBindingMode)), fmt.Sprintf("topology: %v", s.AllowedTopologies))
				r.Foundation = foundation(s.Annotations)
				rows = append(rows, r)
			}
		}
		add("storageclasses", rows, cont, e)
		claims, e := c.cs.CoreV1().PersistentVolumeClaims(ns).List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = claims.Continue
			for _, p := range claims.Items {
				rows = append(rows, item("PersistentVolumeClaim", &p, string(p.Status.Phase), fmt.Sprintf("class: %s / volume: %s / requested: %s / modes: %v / volumeMode: %v", value(p.Spec.StorageClassName), p.Spec.VolumeName, p.Spec.Resources.Requests.Storage().String(), p.Spec.AccessModes, value(p.Spec.VolumeMode)), fmt.Sprintf("conditions: %v", p.Status.Conditions)))
			}
		}
		add("persistentvolumeclaims", rows, cont, e)
		pvs, e := c.cs.CoreV1().PersistentVolumes().List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = pvs.Continue
			for _, p := range pvs.Items {
				rows = append(rows, item("PersistentVolume", &p, string(p.Status.Phase), fmt.Sprintf("class: %s / capacity: %s / reclaim: %s / modes: %v", p.Spec.StorageClassName, p.Spec.Capacity.Storage().String(), p.Spec.PersistentVolumeReclaimPolicy, p.Spec.AccessModes)))
			}
		}
		add("persistentvolumes", rows, cont, e)
		deps, e := c.cs.AppsV1().Deployments(ns).List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = deps.Continue
			for _, d := range deps.Items {
				details := []string{fmt.Sprintf("ready: %d/%d", d.Status.ReadyReplicas, value(d.Spec.Replicas))}
				for _, ct := range d.Spec.Template.Spec.Containers {
					details = append(details, "container: "+ct.Name)
				}
				for _, v := range d.Spec.Template.Spec.Volumes {
					if v.PersistentVolumeClaim != nil {
						details = append(details, "PVC: "+v.PersistentVolumeClaim.ClaimName)
					}
				}
				rows = append(rows, item("Deployment", &d, "", details...))
			}
		}
		add("deployments", rows, cont, e)
		check("create-pvc", "", "persistentvolumeclaims", "create")
		check("create-storage-app", "apps", "deployments", "create")
		check("attach-pvc", "apps", "deployments", "update")
		check("publish-storage", "storage.k8s.io", "storageclasses", "patch")
	}
	if area == "network" {
		classes, e := c.cs.NetworkingV1().IngressClasses().List(ctx, opts)
		var rows []OperationItem
		cont := ""
		if e == nil {
			cont = classes.Continue
			for _, cl := range classes.Items {
				r := item("IngressClass", &cl, cl.Spec.Controller)
				r.Foundation = foundation(cl.Annotations)
				rows = append(rows, r)
			}
		}
		add("ingressclasses", rows, cont, e)
		services, e := c.cs.CoreV1().Services(ns).List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = services.Continue
			for _, s := range services.Items {
				ports := []string{}
				for _, p := range s.Spec.Ports {
					ports = append(ports, fmt.Sprintf("%d/%s", p.Port, p.Protocol))
				}
				rows = append(rows, item("Service", &s, string(s.Spec.Type), strings.Join(ports, ", ")))
			}
		}
		add("services", rows, cont, e)
		ingresses, e := c.cs.NetworkingV1().Ingresses(ns).List(ctx, opts)
		rows = nil
		cont = ""
		if e == nil {
			cont = ingresses.Continue
			for _, i := range ingresses.Items {
				details := []string{"class: " + value(i.Spec.IngressClassName)}
				for _, r := range i.Spec.Rules {
					scheme := "http"
					for _, tls := range i.Spec.TLS {
						for _, host := range tls.Hosts {
							if host == r.Host {
								scheme = "https"
							}
						}
					}
					details = append(details, scheme+"://"+r.Host)
				}
				state := "Awaiting address"
				if len(i.Status.LoadBalancer.Ingress) > 0 {
					state = "Address assigned"
				}
				rows = append(rows, item("Ingress", &i, state, details...))
			}
		}
		add("ingresses", rows, cont, e)
		check("create-ingress", "networking.k8s.io", "ingresses", "create")
		check("publish-ingress", "networking.k8s.io", "ingressclasses", "patch")
	}
	if area == "storage" || area == "network" {
		events, e := c.cs.CoreV1().Events(ns).List(ctx, opts)
		var rows []OperationItem
		cont := ""
		if e == nil {
			cont = events.Continue
			for _, v := range events.Items {
				if v.Type == "Warning" && (v.InvolvedObject.Kind == "PersistentVolumeClaim" || v.InvolvedObject.Kind == "Ingress" || v.InvolvedObject.Kind == "Pod") {
					rows = append(rows, item("Event", &v, v.Reason, v.InvolvedObject.Kind+"/"+v.InvolvedObject.Name, v.Message))
				}
			}
		}
		add("events", rows, cont, e)
	}
	return out
}

func value[T any](p *T) T {
	if p != nil {
		return *p
	}
	var zero T
	return zero
}

// Include init-container peaks, restartable init sidecars and Pod overhead.
func podAllocation(p core.Pod) (cpu, mem, lcpu, lmem int64) {
	totals := func(l core.ResourceList) (int64, int64) { return l.Cpu().MilliValue(), l.Memory().Value() }
	for _, ct := range p.Spec.Containers {
		a, b := totals(ct.Resources.Requests)
		cpu += a
		mem += b
		a, b = totals(ct.Resources.Limits)
		lcpu += a
		lmem += b
	}
	var sc, sm, slc, slm, ic, im, ilc, ilm int64
	for _, ct := range p.Spec.InitContainers {
		a, b := totals(ct.Resources.Requests)
		x, y := totals(ct.Resources.Limits)
		if ct.RestartPolicy != nil && *ct.RestartPolicy == core.ContainerRestartPolicyAlways {
			sc += a
			sm += b
			slc += x
			slm += y
			a, b, x, y = 0, 0, 0, 0
		}
		ic = max(ic, a+sc)
		im = max(im, b+sm)
		ilc = max(ilc, x+slc)
		ilm = max(ilm, y+slm)
	}
	cpu = max(cpu+sc, ic)
	mem = max(mem+sm, im)
	lcpu = max(lcpu+slc, ilc)
	lmem = max(lmem+slm, ilm)
	if p.Spec.Resources != nil {
		if a, b := totals(p.Spec.Resources.Requests); a > 0 || b > 0 {
			cpu = max(cpu, a)
			mem = max(mem, b)
		}
		a, b := totals(p.Spec.Resources.Limits)
		lcpu = max(lcpu, a)
		lmem = max(lmem, b)
	}
	a, b := totals(p.Spec.Overhead)
	return cpu + a, mem + b, lcpu + a, lmem + b
}

func evictionBlock(p core.Pod) string {
	if p.Annotations[core.MirrorPodAnnotationKey] != "" {
		return "blocked: mirror pod"
	}
	owned := false
	for _, o := range p.OwnerReferences {
		if o.Kind == "DaemonSet" {
			return "blocked: DaemonSet"
		}
		if o.Controller != nil && *o.Controller {
			owned = true
		}
	}
	if !owned {
		return "blocked: unmanaged pod"
	}
	for _, v := range p.Spec.Volumes {
		if v.EmptyDir != nil || v.HostPath != nil {
			return "blocked: local data"
		}
	}
	return "PDB checked by Eviction API; review PVC topology, selectors and affinity"
}

func validName(s string) bool { return len(validation.IsDNS1123Subdomain(s)) == 0 }

func (c *Client) RunOperation(ctx context.Context, r OperationRequest) error {
	if !validName(r.Name) {
		return invalidOperation("invalid resource name")
	}
	if r.Action == "cordon" || r.Action == "uncordon" {
		if r.Version == "" {
			return invalidOperation("resource version required; refresh first")
		}
		patch, _ := json.Marshal([]map[string]any{{"op": "test", "path": "/metadata/resourceVersion", "value": r.Version}, {"op": "add", "path": "/spec/unschedulable", "value": r.Action == "cordon"}})
		_, err := c.cs.CoreV1().Nodes().Patch(ctx, r.Name, types.JSONPatchType, patch, meta.PatchOptions{})
		return err
	}
	if r.Action == "publish-storage" || r.Action == "publish-ingress" {
		if r.Version == "" {
			return invalidOperation("resource version required")
		}
		f := r.Foundation
		var encoded any
		if f != nil {
			if len(validation.IsDNS1123Label(f.Namespace)) != 0 {
				return invalidOperation("one valid namespace is required")
			}
			if r.Action == "publish-storage" && (f.MaxGi < 1 || f.MaxGi > 1048576) {
				return invalidOperation("max_gi must be 1..1048576")
			}
			if r.Action == "publish-ingress" && (len(validation.IsDNS1123Subdomain(f.Domain)) != 0 || f.Domain == "" || (f.TLSSecret != "" && !validName(f.TLSSecret))) {
				return invalidOperation("valid domain and TLS secret name required")
			}
			b, _ := json.Marshal(f)
			encoded = string(b)
		}
		b, _ := json.Marshal(map[string]any{"metadata": map[string]any{"resourceVersion": r.Version, "annotations": map[string]any{FoundationAnnotation: encoded}}})
		if r.Action == "publish-storage" {
			_, e := c.cs.StorageV1().StorageClasses().Patch(ctx, r.Name, types.MergePatchType, b, meta.PatchOptions{})
			return e
		}
		_, e := c.cs.NetworkingV1().IngressClasses().Patch(ctx, r.Name, types.MergePatchType, b, meta.PatchOptions{})
		return e
	}
	if len(validation.IsDNS1123Label(r.Namespace)) != 0 {
		return invalidOperation("one namespace is required")
	}
	switch r.Action {
	case "create-storage-app":
		if !validName(r.Claim) || r.Image == "" || len(r.Image) > 512 || strings.ContainsAny(r.Image, " \r\n\t") || !strings.HasPrefix(r.MountPath, "/") || r.MountPath == "/" || strings.Contains(r.MountPath, "..") {
			return invalidOperation("image, PVC and absolute non-root mount path required")
		}
		pvc, e := c.cs.CoreV1().PersistentVolumeClaims(r.Namespace).Get(ctx, r.Claim, meta.GetOptions{})
		if e != nil {
			return e
		}
		if pvc.DeletionTimestamp != nil || (pvc.Spec.VolumeMode != nil && *pvc.Spec.VolumeMode == core.PersistentVolumeBlock) {
			return invalidOperation("PVC must be a non-deleting filesystem volume")
		}
		pods, e := c.cs.CoreV1().Pods(r.Namespace).List(ctx, meta.ListOptions{Limit: 500})
		if e != nil {
			return e
		}
		if pods.Continue != "" {
			return invalidOperation("too many pods to verify volume use")
		}
		for _, p := range pods.Items {
			for _, v := range p.Spec.Volumes {
				if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == r.Claim {
					return invalidOperation("PVC is already referenced by a pod")
				}
			}
		}
		if e := c.unreferencedClaim(ctx, r.Namespace, r.Claim); e != nil {
			return e
		}
		if pvc.Status.Phase != core.ClaimBound {
			sc, e := c.cs.StorageV1().StorageClasses().Get(ctx, value(pvc.Spec.StorageClassName), meta.GetOptions{})
			if e != nil {
				return e
			}
			if string(value(sc.VolumeBindingMode)) != "WaitForFirstConsumer" {
				return invalidOperation("PVC is not Bound; inspect storage events first")
			}
		}
		replicas := int32(1)
		disabled := false
		nonroot := true
		labels := map[string]string{"app.kubernetes.io/name": r.Name, "app.kubernetes.io/managed-by": "kubeport-operations"}
		_, e = c.cs.AppsV1().Deployments(r.Namespace).Create(ctx, &apps.Deployment{
			ObjectMeta: meta.ObjectMeta{Name: r.Name, Namespace: r.Namespace, Labels: labels},
			Spec: apps.DeploymentSpec{Replicas: &replicas, Selector: &meta.LabelSelector{MatchLabels: labels}, Strategy: apps.DeploymentStrategy{Type: apps.RecreateDeploymentStrategyType}, Template: core.PodTemplateSpec{ObjectMeta: meta.ObjectMeta{Labels: labels}, Spec: core.PodSpec{
				AutomountServiceAccountToken: &disabled,
				SecurityContext:              &core.PodSecurityContext{RunAsNonRoot: &nonroot, SeccompProfile: &core.SeccompProfile{Type: core.SeccompProfileTypeRuntimeDefault}},
				Containers:                   []core.Container{{Name: "app", Image: r.Image, SecurityContext: &core.SecurityContext{AllowPrivilegeEscalation: &disabled, Capabilities: &core.Capabilities{Drop: []core.Capability{"ALL"}}}, Resources: core.ResourceRequirements{Requests: core.ResourceList{core.ResourceCPU: resource.MustParse("100m"), core.ResourceMemory: resource.MustParse("128Mi")}, Limits: core.ResourceList{core.ResourceCPU: resource.MustParse("1"), core.ResourceMemory: resource.MustParse("512Mi")}}, VolumeMounts: []core.VolumeMount{{Name: "storage", MountPath: r.MountPath}}}},
				Volumes:                      []core.Volume{{Name: "storage", VolumeSource: core.VolumeSource{PersistentVolumeClaim: &core.PersistentVolumeClaimVolumeSource{ClaimName: r.Claim}}}},
			}}},
		}, meta.CreateOptions{})
		return e
	case "evict":
		n, e := c.cs.CoreV1().Nodes().Get(ctx, r.Node, meta.GetOptions{})
		if e != nil {
			return e
		}
		if !n.Spec.Unschedulable {
			return invalidOperation("cordon the node first")
		}
		p, e := c.cs.CoreV1().Pods(r.Namespace).Get(ctx, r.Name, meta.GetOptions{})
		if e != nil {
			return e
		}
		if r.UID == "" || string(p.UID) != r.UID || p.Spec.NodeName != r.Node {
			return invalidOperation("pod changed; refresh first")
		}
		if strings.HasPrefix(evictionBlock(*p), "blocked:") {
			return invalidOperation("%s", evictionBlock(*p))
		}
		if p.DeletionTimestamp != nil {
			return invalidOperation("pod is already terminating")
		}
		return c.cs.PolicyV1().Evictions(r.Namespace).Evict(ctx, &policy.Eviction{ObjectMeta: meta.ObjectMeta{Name: p.Name, Namespace: p.Namespace}, DeleteOptions: &meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &p.UID}}})
	case "create-pvc":
		sc, e := c.cs.StorageV1().StorageClasses().Get(ctx, r.Class, meta.GetOptions{})
		if e != nil {
			return e
		}
		f := foundation(sc.Annotations)
		if f == nil || f.Namespace != r.Namespace || r.SizeGi < 1 || r.SizeGi > f.MaxGi {
			return invalidOperation("storage class is not offered for this namespace or requested size")
		}
		_, e = c.cs.CoreV1().PersistentVolumeClaims(r.Namespace).Create(ctx, &core.PersistentVolumeClaim{ObjectMeta: meta.ObjectMeta{Name: r.Name, Namespace: r.Namespace}, Spec: core.PersistentVolumeClaimSpec{StorageClassName: &r.Class, AccessModes: []core.PersistentVolumeAccessMode{core.ReadWriteOnce}, Resources: core.VolumeResourceRequirements{Requests: core.ResourceList{core.ResourceStorage: resource.MustParse(fmt.Sprintf("%dGi", r.SizeGi))}}}}, meta.CreateOptions{})
		return e
	case "attach-pvc":
		if !validName(r.Claim) || !strings.HasPrefix(r.MountPath, "/") || r.MountPath == "/" || strings.Contains(r.MountPath, "..") {
			return invalidOperation("valid PVC and absolute non-root mount path required")
		}
		pvc, e := c.cs.CoreV1().PersistentVolumeClaims(r.Namespace).Get(ctx, r.Claim, meta.GetOptions{})
		if e != nil {
			return e
		}
		if pvc.DeletionTimestamp != nil || (pvc.Spec.VolumeMode != nil && *pvc.Spec.VolumeMode == core.PersistentVolumeBlock) {
			return invalidOperation("PVC must be a non-deleting filesystem volume")
		}
		d, e := c.cs.AppsV1().Deployments(r.Namespace).Get(ctx, r.Name, meta.GetOptions{})
		if e != nil {
			return e
		}
		if r.Version == "" || d.ResourceVersion != r.Version {
			return invalidOperation("deployment changed; refresh first")
		}
		// A kubeport release is reconciled from its template. Direct edits would
		// silently disappear on its next update, so those use the template flow.
		if d.Labels["kubeport.io/release"] != "" {
			return invalidOperation("edit the release template to attach storage to a kubeport-managed deployment")
		}
		if value(d.Spec.Replicas) > 1 {
			return invalidOperation("this attachment flow supports single-replica deployments only")
		}
		// No takeover of a volume already used by another Pod. Failed list is not
		// interpreted as unused. WFFC claims may legitimately still be Pending.
		pods, e := c.cs.CoreV1().Pods(r.Namespace).List(ctx, meta.ListOptions{Limit: 500})
		if e != nil {
			return e
		}
		if pods.Continue != "" {
			return invalidOperation("too many pods to verify volume use")
		}
		for _, p := range pods.Items {
			for _, v := range p.Spec.Volumes {
				if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == r.Claim {
					return invalidOperation("PVC is already referenced by a pod")
				}
			}
		}
		if e := c.unreferencedClaim(ctx, r.Namespace, r.Claim); e != nil {
			return e
		}
		if pvc.Status.Phase != core.ClaimBound {
			sc, e := c.cs.StorageV1().StorageClasses().Get(ctx, value(pvc.Spec.StorageClassName), meta.GetOptions{})
			if e != nil {
				return e
			}
			if string(value(sc.VolumeBindingMode)) != "WaitForFirstConsumer" {
				return invalidOperation("PVC is not Bound; inspect storage events first")
			}
		}
		volumeName := "kubeport-storage"
		for _, v := range d.Spec.Template.Spec.Volumes {
			if v.Name == volumeName {
				return invalidOperation("storage mount already exists")
			}
		}
		found := false
		for i := range d.Spec.Template.Spec.Containers {
			ct := &d.Spec.Template.Spec.Containers[i]
			if ct.Name == r.Container {
				for _, m := range ct.VolumeMounts {
					if m.MountPath == r.MountPath {
						return invalidOperation("mount path already used")
					}
				}
				ct.VolumeMounts = append(ct.VolumeMounts, core.VolumeMount{Name: volumeName, MountPath: r.MountPath})
				found = true
			}
		}
		if !found {
			return invalidOperation("container not found")
		}
		d.Spec.Template.Spec.Volumes = append(d.Spec.Template.Spec.Volumes, core.Volume{Name: volumeName, VolumeSource: core.VolumeSource{PersistentVolumeClaim: &core.PersistentVolumeClaimVolumeSource{ClaimName: r.Claim}}})
		d.Spec.Strategy = apps.DeploymentStrategy{Type: apps.RecreateDeploymentStrategyType}
		_, e = c.cs.AppsV1().Deployments(r.Namespace).Update(ctx, d, meta.UpdateOptions{})
		return e
	case "create-ingress":
		cl, e := c.cs.NetworkingV1().IngressClasses().Get(ctx, r.Class, meta.GetOptions{})
		if e != nil {
			return e
		}
		f := foundation(cl.Annotations)
		if f == nil || f.Namespace != r.Namespace || (r.Host != f.Domain && !strings.HasSuffix(r.Host, "."+f.Domain)) || len(validation.IsDNS1123Subdomain(r.Host)) != 0 {
			return invalidOperation("host or namespace is outside the published ingress foundation")
		}
		if !strings.HasPrefix(r.Path, "/") || strings.ContainsAny(r.Path, "?#") || r.Port < 1 || r.Port > 65535 {
			return invalidOperation("valid path and service port required")
		}
		svc, e := c.cs.CoreV1().Services(r.Namespace).Get(ctx, r.Service, meta.GetOptions{})
		if e != nil {
			return e
		}
		portFound := false
		for _, p := range svc.Spec.Ports {
			if p.Port == r.Port && p.Protocol == core.ProtocolTCP {
				portFound = true
			}
		}
		if !portFound || svc.Spec.Type == core.ServiceTypeExternalName {
			return invalidOperation("choose a local service TCP port")
		}
		existing, e := c.cs.NetworkingV1().Ingresses("").List(ctx, meta.ListOptions{Limit: 500})
		if e != nil {
			return e
		}
		if existing.Continue != "" {
			return invalidOperation("too many ingresses to verify host conflicts")
		}
		for _, i := range existing.Items {
			for _, rule := range i.Spec.Rules {
				if rule.Host == r.Host || rule.Host == "" || strings.HasPrefix(rule.Host, "*.") && strings.HasSuffix(r.Host, rule.Host[1:]) {
					return invalidOperation("host overlaps an existing ingress")
				}
			}
		}
		pathType := networking.PathTypePrefix
		ing := &networking.Ingress{ObjectMeta: meta.ObjectMeta{Name: r.Name, Namespace: r.Namespace}, Spec: networking.IngressSpec{IngressClassName: &r.Class, Rules: []networking.IngressRule{{Host: r.Host, IngressRuleValue: networking.IngressRuleValue{HTTP: &networking.HTTPIngressRuleValue{Paths: []networking.HTTPIngressPath{{Path: r.Path, PathType: &pathType, Backend: networking.IngressBackend{Service: &networking.IngressServiceBackend{Name: r.Service, Port: networking.ServiceBackendPort{Number: r.Port}}}}}}}}}}}
		if f.TLSSecret != "" {
			ing.Spec.TLS = []networking.IngressTLS{{Hosts: []string{r.Host}, SecretName: f.TLSSecret}}
		}
		_, e = c.cs.NetworkingV1().Ingresses(r.Namespace).Create(ctx, ing, meta.CreateOptions{})
		return e
	}
	return invalidOperation("unsupported operation")
}

// Pods can lag behind newly created workloads. Check desired references too,
// and refuse an incomplete/forbidden list rather than assuming a claim is free.
func (c *Client) unreferencedClaim(ctx context.Context, ns, claim string) error {
	check := func(volumes []core.Volume) bool {
		for _, v := range volumes {
			if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == claim {
				return true
			}
		}
		return false
	}
	opts := meta.ListOptions{Limit: 500}
	deployments, e := c.cs.AppsV1().Deployments(ns).List(ctx, opts)
	if e != nil {
		return e
	}
	if deployments.Continue != "" {
		return invalidOperation("deployment list is incomplete")
	}
	for _, d := range deployments.Items {
		if check(d.Spec.Template.Spec.Volumes) {
			return invalidOperation("PVC is already referenced by a Deployment")
		}
	}
	sets, e := c.cs.AppsV1().StatefulSets(ns).List(ctx, opts)
	if e != nil {
		return e
	}
	if sets.Continue != "" {
		return invalidOperation("statefulset list is incomplete")
	}
	for _, d := range sets.Items {
		if check(d.Spec.Template.Spec.Volumes) {
			return invalidOperation("PVC is already referenced by a StatefulSet")
		}
	}
	return nil
}
