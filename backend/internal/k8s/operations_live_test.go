package k8s

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	core "k8s.io/api/core/v1"
	networking "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Explicit opt-in: creates only a uniquely named namespace and two classes,
// then removes those exact resources. Never cordons or evicts an existing node.
func TestOperationsLive(t *testing.T) {
	path := os.Getenv("KBP_OPERATIONS_KUBECONFIG")
	if path == "" {
		t.Skip("set KBP_OPERATIONS_KUBECONFIG to an isolated kind cluster")
	}
	cfg, e := clientcmd.BuildConfigFromFlags("", path)
	require.NoError(t, e)
	cs, e := kubernetes.NewForConfig(cfg)
	require.NoError(t, e)
	dyn, e := dynamic.NewForConfig(cfg)
	require.NoError(t, e)
	c := &Client{cs: cs, dyn: dyn}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	name := fmt.Sprintf("kbp-feedback-%d", time.Now().UnixNano())
	_, e = cs.CoreV1().Namespaces().Create(ctx, &core.Namespace{ObjectMeta: meta.ObjectMeta{Name: name}}, meta.CreateOptions{})
	require.NoError(t, e)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = cs.CoreV1().Namespaces().Delete(cleanup, name, meta.DeleteOptions{})
		_ = cs.StorageV1().StorageClasses().Delete(cleanup, name, meta.DeleteOptions{})
		_ = cs.NetworkingV1().IngressClasses().Delete(cleanup, name, meta.DeleteOptions{})
	})
	sc, e := cs.StorageV1().StorageClasses().Get(ctx, "standard", meta.GetOptions{})
	require.NoError(t, e)
	sc.ObjectMeta = meta.ObjectMeta{Name: name}
	sc, e = cs.StorageV1().StorageClasses().Create(ctx, sc, meta.CreateOptions{})
	require.NoError(t, e)
	require.NoError(t, c.RunOperation(ctx, OperationRequest{Action: "publish-storage", Name: name, Version: sc.ResourceVersion, Foundation: &Foundation{Namespace: name, MaxGi: 1}}))
	require.NoError(t, c.RunOperation(ctx, OperationRequest{Action: "create-pvc", Name: "data", Namespace: name, Class: name, SizeGi: 1}))
	require.NoError(t, c.RunOperation(ctx, OperationRequest{Action: "create-storage-app", Name: "app", Namespace: name, Claim: "data", MountPath: "/data", Image: "registry.k8s.io/pause:3.10"}))
	require.Eventually(t, func() bool {
		p, e := cs.CoreV1().PersistentVolumeClaims(name).Get(ctx, "data", meta.GetOptions{})
		return e == nil && p.Status.Phase == core.ClaimBound
	}, 70*time.Second, time.Second, "PVC should bind through WaitForFirstConsumer")
	cl, e := cs.NetworkingV1().IngressClasses().Create(ctx, &networking.IngressClass{ObjectMeta: meta.ObjectMeta{Name: name}, Spec: networking.IngressClassSpec{Controller: "example.test/controller"}}, meta.CreateOptions{})
	require.NoError(t, e)
	require.NoError(t, c.RunOperation(ctx, OperationRequest{Action: "publish-ingress", Name: name, Version: cl.ResourceVersion, Foundation: &Foundation{Namespace: name, Domain: name + ".example.test"}}))
	_, e = cs.CoreV1().Services(name).Create(ctx, &core.Service{ObjectMeta: meta.ObjectMeta{Name: "app"}, Spec: core.ServiceSpec{Selector: map[string]string{"app.kubernetes.io/name": "app"}, Ports: []core.ServicePort{{Port: 80, Protocol: core.ProtocolTCP}}}}, meta.CreateOptions{})
	require.NoError(t, e)
	request := OperationRequest{Action: "create-ingress", Name: "route", Namespace: name, Class: name, Host: "app." + name + ".example.test", Path: "/", Service: "app", Port: 80}
	require.NoError(t, c.RunOperation(ctx, request))
	request.Name = "duplicate"
	require.Error(t, c.RunOperation(ctx, request))
	snapshot := c.InspectOperations(ctx, "storage", name)
	found := false
	for _, s := range snapshot.Sections {
		if s.Resource == "persistentvolumeclaims" {
			require.Empty(t, s.Error)
			require.Len(t, s.Items, 1)
			require.Equal(t, "Bound", s.Items[0].Status)
			found = true
		}
	}
	require.True(t, found)
	deniedCfg := rest.CopyConfig(cfg)
	deniedCfg.Impersonate = rest.ImpersonationConfig{UserName: name + "-denied"}
	denied, e := kubernetes.NewForConfig(deniedCfg)
	require.NoError(t, e)
	require.True(t, apierrors.IsForbidden((&Client{cs: denied}).RunOperation(ctx, OperationRequest{Action: "create-pvc", Name: "denied", Namespace: name, Class: name, SizeGi: 1})))
	require.NoError(t, cs.AppsV1().Deployments(name).Delete(ctx, "app", meta.DeleteOptions{}))
	_, e = cs.CoreV1().PersistentVolumeClaims(name).Get(ctx, "data", meta.GetOptions{})
	require.NoError(t, e, "deleting app must retain PVC")
}
