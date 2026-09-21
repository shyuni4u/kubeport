package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	apps "k8s.io/api/apps/v1"
	authv1 "k8s.io/api/authorization/v1"
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
	dynamicfake "k8s.io/client-go/dynamic/fake"
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

// evictionAnswers records every pods/eviction review and answers each from
// allow, keyed by namespace. A namespace missing from fail answers normally;
// one present fails the review outright.
func evictionAnswers(cs *fake.Clientset, allow map[string]bool, fail map[string]bool) *[]string {
	var asked []string
	cs.PrependReactor("create", "selfsubjectaccessreviews", func(a kt.Action) (bool, runtime.Object, error) {
		spec := a.(kt.CreateAction).GetObject().(*authv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		if spec.Resource != "pods" || spec.Subresource != "eviction" {
			return true, &authv1.SelfSubjectAccessReview{}, nil
		}
		asked = append(asked, spec.Namespace)
		if fail[spec.Namespace] {
			return true, nil, apierrors.NewServiceUnavailable("review unavailable")
		}
		return true, &authv1.SelfSubjectAccessReview{Status: authv1.SubjectAccessReviewStatus{Allowed: allow[spec.Namespace]}}, nil
	})
	return &asked
}

// The pods on a node come from every namespace, so one decision taken on the
// request's namespace would disable eviction where it is allowed and enable it
// where it is refused (#437).
func evictNodesFixture() []runtime.Object {
	yes := true
	owner := []meta.OwnerReference{{Kind: "ReplicaSet", Name: "app", Controller: &yes}}
	return []runtime.Object{
		&core.Node{ObjectMeta: meta.ObjectMeta{Name: "node-a"}},
		&core.Pod{ObjectMeta: meta.ObjectMeta{Name: "a1", Namespace: "alpha", OwnerReferences: owner}, Spec: core.PodSpec{NodeName: "node-a"}},
		&core.Pod{ObjectMeta: meta.ObjectMeta{Name: "a2", Namespace: "alpha", OwnerReferences: owner}, Spec: core.PodSpec{NodeName: "node-a"}},
		&core.Pod{ObjectMeta: meta.ObjectMeta{Name: "b1", Namespace: "beta", OwnerReferences: owner}, Spec: core.PodSpec{NodeName: "node-a"}},
	}
}

func evictablePods(s OperationSnapshot) map[string]*bool {
	out := map[string]*bool{}
	for _, sec := range s.Sections {
		for _, i := range sec.Items {
			if i.Kind == "Pod" {
				out[i.Name] = i.Evictable
			}
		}
	}
	return out
}

func TestInspectNodesDecidesEvictionInEachPodsOwnNamespace(t *testing.T) {
	c, cs := nodesClient()
	asked := evictionAnswers(cs, map[string]bool{"beta": true}, nil)
	// "alpha" is what the screen sends and cannot show; "beta" is where the
	// caller may actually evict.
	got := evictablePods(c.InspectOperations(context.Background(), "nodes", "alpha"))
	require.Equal(t, false, *got["a1"])
	require.Equal(t, false, *got["a2"])
	require.Equal(t, true, *got["b1"], "a pod in a namespace the caller may evict in must stay available")
	// One review per distinct namespace, not per pod.
	require.ElementsMatch(t, []string{"alpha", "beta"}, *asked)
}

func TestInspectNodesEvictionIgnoresTheRequestNamespace(t *testing.T) {
	for _, ns := range []string{"alpha", "beta", "does-not-exist", ""} {
		t.Run("request="+ns, func(t *testing.T) {
			c, cs := nodesClient()
			evictionAnswers(cs, map[string]bool{"beta": true}, nil)
			got := evictablePods(c.InspectOperations(context.Background(), "nodes", ns))
			require.Equal(t, false, *got["a1"])
			require.Equal(t, true, *got["b1"])
		})
	}
}

// An unanswered review is not a denial: leaving it unknown keeps the button
// available and lets Kubernetes RBAC give the real answer.
func TestInspectNodesLeavesEvictionUnknownWhenTheReviewFails(t *testing.T) {
	c, cs := nodesClient()
	evictionAnswers(cs, map[string]bool{"beta": true}, map[string]bool{"alpha": true})
	s := c.InspectOperations(context.Background(), "nodes", "alpha")
	got := evictablePods(s)
	require.Nil(t, got["a1"])
	require.Equal(t, true, *got["b1"])
	require.True(t, s.Permissions["evict"])
}

// False only when every namespace answered no, so the screen-wide gate never
// hides a pod whose own namespace was never asked.
func TestInspectNodesEvictPermissionFalseOnlyWhenEveryNamespaceRefuses(t *testing.T) {
	c, cs := nodesClient()
	evictionAnswers(cs, nil, nil)
	require.False(t, c.InspectOperations(context.Background(), "nodes", "alpha").Permissions["evict"])

	c, cs = nodesClient()
	evictionAnswers(cs, map[string]bool{"beta": true}, nil)
	require.True(t, c.InspectOperations(context.Background(), "nodes", "alpha").Permissions["evict"])
}

// nodesClient is opsClient with a dynamic client too: the node area also asks
// metrics.k8s.io, and a nil dynamic client panics there.
func nodesClient() (*Client, *fake.Clientset) {
	cs := fake.NewClientset(evictNodesFixture()...)
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}: "NodeMetricsList",
		})
	return &Client{cs: cs, dyn: dyn}, cs
}

// A cluster with more namespaces than the budget must not turn one open node
// screen into hundreds of reviews every refresh. The ones past the budget stay
// unknown, so their pods stay actionable rather than silently disabled.
func TestInspectNodesBoundsHowManyNamespacesItReviews(t *testing.T) {
	yes := true
	owner := []meta.OwnerReference{{Kind: "ReplicaSet", Name: "app", Controller: &yes}}
	objs := []runtime.Object{&core.Node{ObjectMeta: meta.ObjectMeta{Name: "node-a"}}}
	for i := 0; i < evictionCheckBudget+10; i++ {
		objs = append(objs, &core.Pod{
			ObjectMeta: meta.ObjectMeta{Name: fmt.Sprintf("p%d", i), Namespace: fmt.Sprintf("ns%03d", i), OwnerReferences: owner},
			Spec:       core.PodSpec{NodeName: "node-a"},
		})
	}
	cs := fake.NewClientset(objs...)
	asked := evictionAnswers(cs, nil, nil)
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}: "NodeMetricsList",
		})
	c := &Client{cs: cs, dyn: dyn}
	got := evictablePods(c.InspectOperations(context.Background(), "nodes", ""))
	require.Len(t, *asked, evictionCheckBudget)
	answered := 0
	for _, v := range got {
		if v != nil {
			answered++
		}
	}
	require.Equal(t, evictionCheckBudget, answered)
	require.Len(t, got, evictionCheckBudget+10)
}
