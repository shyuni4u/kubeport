package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientgotesting "k8s.io/client-go/testing"

	"kubeport/internal/k8s"
)

// security review of #340: with whenDeleted: Delete the StatefulSet controller
// takes over any claim named <claim>-<statefulset>-<ordinal> that no other
// controller owns, and deleting the release deletes it. Those names are not in
// the manifest, so CheckApply has to look for them.

const dbStatefulSet = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  persistentVolumeClaimRetentionPolicy: {whenDeleted: Delete}
  volumeClaimTemplates:
    - metadata: {name: data}
`

const claimKind = "PersistentVolumeClaim"

func TestCheckApply_OnCreateAClaimTheStatefulSetWouldTakeIsAConflict(t *testing.T) {
	dyn := cluster(
		existing("v1", claimKind, "demo", "data-db-0", ""),
		existing("v1", claimKind, "demo", "data-db-7", "earlier"),
	)
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), true)
	require.NoError(t, err)
	require.ElementsMatch(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-7", Namespace: "demo"}, Owner: "earlier"},
	}, check.Conflicts, "every ordinal, not only the replicas rendered today")
	require.Empty(t, check.Unverified)
}

func TestCheckApply_ClaimsOfOtherNamesAreNotConflicts(t *testing.T) {
	dyn := cluster(
		existing("v1", claimKind, "demo", "data-db-x-0", ""), // claim data of StatefulSet db-x
		existing("v1", claimKind, "demo", "logs-db-0", ""),
		existing("v1", claimKind, "demo", "data-db-", ""),
		existing("v1", claimKind, "demo", "data-db-0a", ""),
		existing("v1", claimKind, "other", "data-db-0", ""),
	)
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), true)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
}

func TestCheckApply_ClaimsARetainingStatefulSetMountsAreNotChecked(t *testing.T) {
	retain := `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  persistentVolumeClaimRetentionPolicy: {whenDeleted: Retain}
  volumeClaimTemplates:
    - metadata: {name: data}
`
	dyn := cluster(existing("v1", claimKind, "demo", "data-db-0", ""))
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(retain), true)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts, "a template that keeps its data may mean to reattach it")
}

func TestCheckApply_OnUpdateTheStatefulSetsClaimsAreItsOwn(t *testing.T) {
	dyn := cluster(
		stamped("apps/v1", "StatefulSet", "demo", "db", "db", uidMine),
		existing("v1", claimKind, "demo", "data-db-0", ""),
	)
	listed := false
	dyn.PrependReactor("list", "persistentvolumeclaims", func(clientgotesting.Action) (bool, runtime.Object, error) {
		listed = true
		return false, nil, nil
	})
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
	require.False(t, listed, "an update does not look for them")
}

func TestCheckApply_ClaimsTheCallerMayNotListAreUnverified(t *testing.T) {
	dyn := cluster(existing("v1", claimKind, "demo", "data-db-0", ""))
	dyn.PrependReactor("list", "persistentvolumeclaims", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(
			schema.GroupResource{Resource: "persistentvolumeclaims"}, "", errors.New("the role withholds list"))
	})
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), true)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
	require.Equal(t, []k8s.ObjectRef{{Kind: claimKind, Name: "data-db-<ordinal>", Namespace: "demo"}}, check.Unverified)
}

func TestCheckApply_ClaimListErrorsSurface(t *testing.T) {
	dyn := cluster()
	dyn.PrependReactor("list", "persistentvolumeclaims", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewServiceUnavailable("apiserver is restarting")
	})
	_, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), true)
	require.Error(t, err)
}
