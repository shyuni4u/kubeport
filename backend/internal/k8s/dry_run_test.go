package k8s_test

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clienttesting "k8s.io/client-go/testing"
	"kubeport/internal/k8s"
	"testing"
)

func TestDryRunCreateNeverPersists(t *testing.T) {
	dyn := cluster()
	calls := 0
	dyn.PrependReactor("create", "*", func(a clienttesting.Action) (bool, runtime.Object, error) {
		action := a.(clienttesting.CreateActionImpl)
		require.Equal(t, []string{metav1.DryRunAll}, action.GetCreateOptions().DryRun)
		require.Equal(t, metav1.FieldValidationStrict, action.GetCreateOptions().FieldValidation)
		require.Equal(t, "test", action.GetNamespace())
		calls++
		return true, action.GetObject(), nil
	})
	require.NoError(t, k8s.NewForTest(dyn).DryRunCreate(context.Background(), "test", []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n")))
	require.Equal(t, 1, calls)
	_, err := dyn.Tracker().Get(schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}, "test", "test")
	require.True(t, apierrors.IsNotFound(err))
}

func TestDryRunCreateRefusals(t *testing.T) {
	for _, refusal := range []error{apierrors.NewForbidden(schema.GroupResource{Resource: "configmaps"}, "test", errors.New("denied")), apierrors.NewAlreadyExists(schema.GroupResource{Resource: "configmaps"}, "test"), apierrors.NewBadRequest("strict decoding error: unknown field")} {
		dyn := cluster()
		dyn.PrependReactor("create", "*", func(clienttesting.Action) (bool, runtime.Object, error) {
			return true, &unstructured.Unstructured{}, refusal
		})
		err := k8s.NewForTest(dyn).DryRunCreate(context.Background(), "test", []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n"))
		require.ErrorIs(t, err, refusal)
	}
	dyn := cluster()
	err := k8s.NewForTest(dyn).DryRunCreate(context.Background(), "test", []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: test\n  namespace: other\n"))
	require.Error(t, err)
	require.Empty(t, dyn.Actions())
}
