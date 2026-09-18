package k8s

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	apps "k8s.io/api/apps/v1"
	core "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	policy "k8s.io/api/policy/v1"
	storage "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	kt "k8s.io/client-go/testing"
)

func opsClient(objects ...runtime.Object) (*Client, *fake.Clientset) {
	cs := fake.NewClientset(objects...)
	return &Client{cs: cs}, cs
}
func offered(f Foundation) map[string]string {
	b, _ := json.Marshal(f)
	return map[string]string{FoundationAnnotation: string(b)}
}
func boundClaim() *core.PersistentVolumeClaim {
	return &core.PersistentVolumeClaim{ObjectMeta: meta.ObjectMeta{Name: "data", Namespace: "team"}, Status: core.PersistentVolumeClaimStatus{Phase: core.ClaimBound}}
}

func TestOperationsPVCPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, ns string
		size     int64
		allow    bool
	}{{"valid", "team", 2, true}, {"wrong namespace", "other", 2, false}, {"over limit", "team", 11, false}, {"zero", "team", 0, false}} {
		t.Run(tc.name, func(t *testing.T) {
			c, cs := opsClient(&storage.StorageClass{ObjectMeta: meta.ObjectMeta{Name: "fast", Annotations: offered(Foundation{Namespace: "team", MaxGi: 10})}})
			e := c.RunOperation(context.Background(), OperationRequest{Action: "create-pvc", Name: "data", Namespace: tc.ns, Class: "fast", SizeGi: tc.size})
			if tc.allow {
				require.NoError(t, e)
				p, e := cs.CoreV1().PersistentVolumeClaims("team").Get(context.Background(), "data", meta.GetOptions{})
				require.NoError(t, e)
				require.Equal(t, "2Gi", p.Spec.Resources.Requests.Storage().String())
				require.Equal(t, []core.PersistentVolumeAccessMode{core.ReadWriteOnce}, p.Spec.AccessModes)
			} else {
				require.Error(t, e)
				for _, a := range cs.Actions() {
					require.NotEqual(t, "create", a.GetVerb())
				}
			}
		})
	}
}

func TestOperationsStorageAppRetainsPVC(t *testing.T) {
	c, cs := opsClient(boundClaim())
	require.NoError(t, c.RunOperation(context.Background(), OperationRequest{Action: "create-storage-app", Namespace: "team", Name: "app", Image: "example/app:1", Claim: "data", MountPath: "/data"}))
	d, e := cs.AppsV1().Deployments("team").Get(context.Background(), "app", meta.GetOptions{})
	require.NoError(t, e)
	require.Equal(t, "data", d.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim.ClaimName)
	require.False(t, *d.Spec.Template.Spec.AutomountServiceAccountToken)
	p, e := cs.CoreV1().PersistentVolumeClaims("team").Get(context.Background(), "data", meta.GetOptions{})
	require.NoError(t, e)
	require.Empty(t, p.OwnerReferences)
}

func TestOperationsStorageRefusesUsedAndBlockPVC(t *testing.T) {
	for _, block := range []bool{false, true} {
		t.Run(map[bool]string{false: "in use", true: "block"}[block], func(t *testing.T) {
			pvc := boundClaim()
			if block {
				v := core.PersistentVolumeBlock
				pvc.Spec.VolumeMode = &v
			}
			p := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "other", Namespace: "team"}, Spec: core.PodSpec{Volumes: []core.Volume{{Name: "data", VolumeSource: core.VolumeSource{PersistentVolumeClaim: &core.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}}}}}
			c, _ := opsClient(pvc, p)
			require.Error(t, c.RunOperation(context.Background(), OperationRequest{Action: "create-storage-app", Namespace: "team", Name: "app", Image: "example/app:1", Claim: "data", MountPath: "/data"}))
		})
	}
}

func TestOperationsAttachmentDoesNotModifyManagedOrStaleDeployment(t *testing.T) {
	for _, managed := range []bool{true, false} {
		d := &apps.Deployment{ObjectMeta: meta.ObjectMeta{Name: "app", Namespace: "team", ResourceVersion: "2"}}
		if managed {
			d.Labels = map[string]string{ReleaseLabel: "owned"}
		}
		c, cs := opsClient(boundClaim(), d)
		version := "1"
		if managed {
			version = "2"
		}
		require.Error(t, c.RunOperation(context.Background(), OperationRequest{Action: "attach-pvc", Name: "app", Namespace: "team", Version: version, Claim: "data", MountPath: "/data", Container: "app"}))
		for _, a := range cs.Actions() {
			require.NotEqual(t, "update", a.GetVerb())
		}
	}
}

func TestOperationsEvictionUsesPDBAndUIDPreconditions(t *testing.T) {
	yes := true
	pod := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "app", Namespace: "team", UID: types.UID("original"), OwnerReferences: []meta.OwnerReference{{Kind: "ReplicaSet", Name: "app", Controller: &yes}}}, Spec: core.PodSpec{NodeName: "node-a"}}
	node := &core.Node{ObjectMeta: meta.ObjectMeta{Name: "node-a"}, Spec: core.NodeSpec{Unschedulable: true}}
	c, cs := opsClient(pod, node)
	calls := 0
	cs.PrependReactor("create", "pods", func(a kt.Action) (bool, runtime.Object, error) {
		require.Equal(t, "eviction", a.GetSubresource())
		e := a.(kt.CreateAction).GetObject().(*policy.Eviction)
		require.Equal(t, pod.UID, *e.DeleteOptions.Preconditions.UID)
		calls++
		return true, nil, apierrors.NewTooManyRequests("PDB blocks", 1)
	})
	err := c.RunOperation(context.Background(), OperationRequest{Action: "evict", Name: "app", Namespace: "team", Node: "node-a", UID: "original"})
	require.True(t, apierrors.IsTooManyRequests(err))
	require.Equal(t, 1, calls)
	err = c.RunOperation(context.Background(), OperationRequest{Action: "evict", Name: "app", Namespace: "team", Node: "node-a", UID: "replacement"})
	require.Error(t, err)
	require.Equal(t, 1, calls)
	for _, a := range cs.Actions() {
		require.NotEqual(t, "delete", a.GetVerb())
	}
}

func TestOperationsEvictionRejectsUnsafePods(t *testing.T) {
	yes := true
	base := core.Pod{ObjectMeta: meta.ObjectMeta{OwnerReferences: []meta.OwnerReference{{Kind: "ReplicaSet", Controller: &yes}}}}
	for _, tc := range []struct {
		name string
		edit func(*core.Pod)
	}{
		{"unmanaged", func(p *core.Pod) { p.OwnerReferences = nil }},
		{"daemonset", func(p *core.Pod) { p.OwnerReferences[0].Kind = "DaemonSet" }},
		{"mirror", func(p *core.Pod) { p.Annotations = map[string]string{core.MirrorPodAnnotationKey: "x"} }},
		{"emptyDir", func(p *core.Pod) {
			p.Spec.Volumes = []core.Volume{{VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{}}}}
		}},
		{"hostPath", func(p *core.Pod) {
			p.Spec.Volumes = []core.Volume{{VolumeSource: core.VolumeSource{HostPath: &core.HostPathVolumeSource{Path: "/data"}}}}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := base.DeepCopy()
			tc.edit(p)
			require.Contains(t, evictionBlock(*p), "blocked:")
		})
	}
}

func TestOperationsIngressFoundation(t *testing.T) {
	for _, tc := range []struct {
		host, ns string
		conflict bool
		allow    bool
	}{{"app.example.org", "team", false, true}, {"example.org.evil.test", "team", false, false}, {"app.example.org", "other", false, false}, {"app.example.org", "team", true, false}} {
		t.Run(tc.host+tc.ns+map[bool]string{true: "conflict"}[tc.conflict], func(t *testing.T) {
			cl := &netv1.IngressClass{ObjectMeta: meta.ObjectMeta{Name: "public", Annotations: offered(Foundation{Namespace: "team", Domain: "example.org", TLSSecret: "wildcard"})}}
			svc := &core.Service{ObjectMeta: meta.ObjectMeta{Name: "web", Namespace: "team"}, Spec: core.ServiceSpec{Ports: []core.ServicePort{{Port: 80, Protocol: core.ProtocolTCP}}}}
			objs := []runtime.Object{cl, svc}
			if tc.conflict {
				objs = append(objs, &netv1.Ingress{ObjectMeta: meta.ObjectMeta{Name: "other", Namespace: "other"}, Spec: netv1.IngressSpec{Rules: []netv1.IngressRule{{Host: tc.host}}}})
			}
			c, cs := opsClient(objs...)
			e := c.RunOperation(context.Background(), OperationRequest{Action: "create-ingress", Namespace: tc.ns, Name: "route", Class: "public", Host: tc.host, Path: "/", Service: "web", Port: 80})
			if tc.allow {
				require.NoError(t, e)
				i, e := cs.NetworkingV1().Ingresses("team").Get(context.Background(), "route", meta.GetOptions{})
				require.NoError(t, e)
				require.Equal(t, "wildcard", i.Spec.TLS[0].SecretName)
			} else {
				require.Error(t, e)
			}
		})
	}
}

func TestOperationsPreservesClusterForbidden(t *testing.T) {
	c, cs := opsClient()
	cs.PrependReactor("patch", "nodes", func(kt.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "nodes"}, "node-a", nil)
	})
	require.True(t, apierrors.IsForbidden(c.RunOperation(context.Background(), OperationRequest{Action: "cordon", Name: "node-a", Version: "1"})))
}

func TestPodAllocationIncludesInitPeakSidecarAndOverhead(t *testing.T) {
	req := func(cpu string) core.ResourceRequirements {
		return core.ResourceRequirements{Requests: core.ResourceList{core.ResourceCPU: resource.MustParse(cpu)}}
	}
	always := core.ContainerRestartPolicyAlways
	p := core.Pod{Spec: core.PodSpec{Containers: []core.Container{{Resources: req("100m")}}, InitContainers: []core.Container{{RestartPolicy: &always, Resources: req("50m")}, {Resources: req("500m")}}, Overhead: core.ResourceList{core.ResourceCPU: resource.MustParse("10m")}}}
	cpu, _, _, _ := podAllocation(p)
	require.Equal(t, int64(560), cpu)
	p.Spec.InitContainers = p.Spec.InitContainers[:1]
	cpu, _, _, _ = podAllocation(p)
	require.Equal(t, int64(160), cpu)
}
