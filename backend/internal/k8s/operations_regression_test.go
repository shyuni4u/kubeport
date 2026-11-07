package k8s

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	authv1 "k8s.io/api/authorization/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kt "k8s.io/client-go/testing"
)

func TestEvictRejectsMissingNodeBeforeClusterCall(t *testing.T) {
	for _, node := range []string{"", "../other", "Bad Node"} {
		c, cs := opsClient()
		err := c.RunOperation(context.Background(), OperationRequest{Action: "evict", Name: "pod", Namespace: "team", Node: node})
		var invalid *OperationValidationError
		require.ErrorAs(t, err, &invalid)
		require.Empty(t, cs.Actions())
	}
	controller := true
	pod := core.Pod{ObjectMeta: meta.ObjectMeta{OwnerReferences: []meta.OwnerReference{{Kind: "ReplicaSet", Controller: &controller}}}}
	require.Contains(t, evictionBlock(pod), "blocked: pod is not assigned")
}

func TestClassAndServiceRejectedBeforeClusterCall(t *testing.T) {
	cases := []OperationRequest{
		{Action: "create-pvc", Class: "", SizeGi: 1},
		{Action: "create-pvc", Class: "../other", SizeGi: 1},
		{Action: "create-ingress", Class: "", Service: "web", Host: "a.example.com", Path: "/", Port: 80},
		{Action: "create-ingress", Class: "a/b", Service: "web", Host: "a.example.com", Path: "/", Port: 80},
		{Action: "create-ingress", Class: "nginx", Service: "", Host: "a.example.com", Path: "/", Port: 80},
		{Action: "create-ingress", Class: "nginx", Service: "Bad Svc", Host: "a.example.com", Path: "/", Port: 80},
	}
	for _, r := range cases {
		r.Name, r.Namespace = "res", "team"
		c, cs := opsClient()
		err := c.RunOperation(context.Background(), r)
		var invalid *OperationValidationError
		require.ErrorAs(t, err, &invalid, "%+v", r)
		require.Empty(t, cs.Actions(), "%+v", r)
	}
}

func TestIngressPermissionIncludesClusterWideConflictRead(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		c, cs := opsClient()
		asked := false
		cs.PrependReactor("create", "selfsubjectaccessreviews", func(a kt.Action) (bool, runtime.Object, error) {
			r := a.(kt.CreateAction).GetObject().(*authv1.SelfSubjectAccessReview)
			attrs := r.Spec.ResourceAttributes
			r.Status.Allowed = true
			if attrs.Resource == "ingresses" && attrs.Verb == "list" && attrs.Namespace == "" {
				asked = true
				r.Status.Allowed = allowed
			}
			return true, r, nil
		})
		snapshot := c.InspectOperations(context.Background(), "network", "team")
		require.True(t, asked)
		require.Equal(t, allowed, snapshot.Permissions["create-ingress"])
	}
}
