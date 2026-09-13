package k8s_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

// A StatefulSet the release already runs has its own claims only where there
// is evidence of it:
//   - the StatefulSet already owns the claim (its controller does so under
//     Delete, and keeps doing so for a claim a scale-down left), or
//   - the claim's ordinal is one of the StatefulSet's current replicas, which a
//     pod of it mounts, and the claim is not older than the StatefulSet.
//
// security review: an older claim is one it was deployed next to — under
// Retain, or before this default existed — and turning Delete on would take
// it. codex review: a newer claim at an ordinal beyond the current replicas is
// not evidence of anything; a scale-up would take it.
func TestCheckApply_OnUpdateOnlyClaimsTheStatefulSetEvidentlyHasAreItsOwn(t *testing.T) {
	born := func(u interface{ UnstructuredContent() map[string]any }, ts string) {
		u.UnstructuredContent()["metadata"].(map[string]any)["creationTimestamp"] = ts
	}
	sts := stamped("apps/v1", "StatefulSet", "demo", "db", "db", uidMine)
	sts.SetUID("sts-db")
	sts.Object["spec"] = map[string]any{"replicas": int64(3)}
	born(sts, "2026-09-02T00:00:00Z")

	olderInRange := existing("v1", claimKind, "demo", "data-db-0", "")
	born(olderInRange, "2026-09-01T00:00:00Z")
	newerInRange := existing("v1", claimKind, "demo", "data-db-1", "")
	born(newerInRange, "2026-09-03T00:00:00Z")
	sameSecondInRange := existing("v1", claimKind, "demo", "data-db-2", "")
	born(sameSecondInRange, "2026-09-02T00:00:00Z")
	newerBeyond := existing("v1", claimKind, "demo", "data-db-3", "")
	born(newerBeyond, "2026-09-03T00:00:00Z")
	ownedBeyond := existing("v1", claimKind, "demo", "data-db-9", "")
	born(ownedBeyond, "2026-09-03T00:00:00Z")
	ownedBeyond.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "sts-db"}})
	ownedByAnother := existing("v1", claimKind, "demo", "data-db-8", "")
	born(ownedByAnother, "2026-09-03T00:00:00Z")
	ownedByAnother.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "an-earlier-db"}})

	check, err := k8s.NewForTest(cluster(sts, olderInRange, newerInRange, sameSecondInRange, newerBeyond, ownedBeyond, ownedByAnother)).
		CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.ElementsMatch(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-3", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-8", Namespace: "demo"}},
	}, check.Conflicts)
}

// ordinals.start moves the range the current replicas cover.
func TestCheckApply_OnUpdateTheReplicaRangeStartsAtOrdinalsStart(t *testing.T) {
	sts := stamped("apps/v1", "StatefulSet", "demo", "db", "db", uidMine)
	sts.Object["spec"] = map[string]any{"replicas": int64(2), "ordinals": map[string]any{"start": int64(5)}}
	check, err := k8s.NewForTest(cluster(sts,
		existing("v1", claimKind, "demo", "data-db-0", ""),
		existing("v1", claimKind, "demo", "data-db-5", ""),
		existing("v1", claimKind, "demo", "data-db-6", ""),
	)).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Equal(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
	}, check.Conflicts)
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
