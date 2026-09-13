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
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
}

// security review of #340: a StatefulSet the release already runs can still
// take a claim it never made — one that was there when it was deployed with
// Retain, or before this default existed, and that it has been mounting. Its
// controller makes its claims after it exists, so a claim older than the
// StatefulSet is not its own.
func TestCheckApply_OnUpdateAClaimOlderThanTheReleasesStatefulSetIsAConflict(t *testing.T) {
	sts := stamped("apps/v1", "StatefulSet", "demo", "db", "db", uidMine)
	sts.Object["metadata"].(map[string]any)["creationTimestamp"] = "2026-09-02T00:00:00Z"
	before := existing("v1", claimKind, "demo", "data-db-0", "")
	before.Object["metadata"].(map[string]any)["creationTimestamp"] = "2026-09-01T00:00:00Z"
	after := existing("v1", claimKind, "demo", "data-db-1", "")
	after.Object["metadata"].(map[string]any)["creationTimestamp"] = "2026-09-03T00:00:00Z"
	same := existing("v1", claimKind, "demo", "data-db-2", "")
	same.Object["metadata"].(map[string]any)["creationTimestamp"] = "2026-09-02T00:00:00Z"

	check, err := k8s.NewForTest(cluster(sts, before, after, same)).
		CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
	}, check.Conflicts, "claims made with or after the StatefulSet are its controller's")
}

// codex review: an update can add a StatefulSet — a new template version, or
// a renamed one. Its claims are not the release's yet, so they are checked as
// on a create.
func TestCheckApply_OnUpdateAStatefulSetTheReleaseDoesNotHaveYetIsChecked(t *testing.T) {
	dyn := cluster(existing("v1", claimKind, "demo", "data-db-0", ""))
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
	}, check.Conflicts)
}

func TestCheckApply_OnUpdateAStatefulSetTheCallerMayNotReadLeavesItsClaimsUnverified(t *testing.T) {
	dyn := cluster(existing("v1", claimKind, "demo", "data-db-0", ""))
	forbidGet(dyn, "statefulsets")
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts, "whether it is the release's own cannot be told")
	require.Equal(t, []k8s.ObjectRef{
		{Kind: "StatefulSet", Name: "db", Namespace: "demo"},
		{Kind: claimKind, Name: "data-db-<ordinal>", Namespace: "demo"},
	}, check.Unverified)
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
