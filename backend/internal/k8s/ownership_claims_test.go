package k8s_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
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

// born sets an object's creation time, which the apiserver would.
func born(u interface{ UnstructuredContent() map[string]any }, ts string) {
	u.UnstructuredContent()["metadata"].(map[string]any)["creationTimestamp"] = ts
}

// runningDB is release db's StatefulSet as the cluster has it.
func runningDB() *unstructured.Unstructured {
	sts := stamped("apps/v1", "StatefulSet", "demo", "db", "db", uidMine)
	sts.SetUID("sts-db")
	born(sts, "2026-09-02T00:00:00Z")
	return sts
}

// podOf is a pod owned by the object with ownerUID that mounts claims.
func podOf(name, ownerUID string, claims ...string) *unstructured.Unstructured {
	p := existing("v1", "Pod", "demo", name, "")
	p.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: types.UID(ownerUID)}})
	volumes := make([]any, 0, len(claims))
	for i, c := range claims {
		volumes = append(volumes, map[string]any{
			"name":                  fmt.Sprintf("v%d", i),
			"persistentVolumeClaim": map[string]any{"claimName": c},
		})
	}
	p.Object["spec"] = map[string]any{"volumes": volumes}
	return p
}

func claimBorn(name, ts string) *unstructured.Unstructured {
	c := existing("v1", claimKind, "demo", name, "")
	born(c, ts)
	return c
}

func TestCheckApply_OnUpdateTheStatefulSetsClaimsAreItsOwn(t *testing.T) {
	dyn := cluster(
		runningDB(),
		claimBorn("data-db-0", "2026-09-02T00:00:05Z"),
		podOf("db-0", "sts-db", "data-db-0"),
	)
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
	require.Empty(t, check.Unverified)
}

// A StatefulSet the release already runs has its own claims only on evidence:
// it already owns the claim, or its pod at that ordinal mounts the claim and
// the claim is not older than it.
//
// security review: an older claim is one it was deployed next to — under
// Retain, or before this default existed — and turning Delete on would take it.
// codex review: neither creation order nor the replica count is evidence. A
// claim made after the StatefulSet at an ordinal with no pod — beyond the
// replicas, or held back behind a pod that never became ready — is mounted by
// nothing, and the controller would take it on reaching that ordinal.
func TestCheckApply_OnUpdateOnlyClaimsTheStatefulSetEvidentlyHasAreItsOwn(t *testing.T) {
	sts := runningDB()
	sts.Object["spec"] = map[string]any{"replicas": int64(8)}

	ownedByIt := claimBorn("data-db-9", "2026-09-03T00:00:00Z")
	ownedByIt.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "sts-db"}})
	ownedByAnother := claimBorn("data-db-8", "2026-09-03T00:00:00Z")
	ownedByAnother.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "an-earlier-db"}})

	check, err := k8s.NewForTest(cluster(sts,
		claimBorn("data-db-0", "2026-09-01T00:00:00Z"), podOf("db-0", "sts-db", "data-db-0"), // mounted, but older
		claimBorn("data-db-1", "2026-09-03T00:00:00Z"), podOf("db-1", "sts-db", "data-db-1"), // mounted and newer
		claimBorn("data-db-2", "2026-09-02T00:00:00Z"), podOf("db-2", "sts-db", "data-db-2"), // mounted, same second
		claimBorn("data-db-3", "2026-09-03T00:00:00Z"),                                             // within replicas, but its pod is held back
		claimBorn("data-db-4", "2026-09-03T00:00:00Z"), podOf("db-4", "someone-else", "data-db-4"), // a pod that is not the StatefulSet's
		claimBorn("data-db-5", "2026-09-03T00:00:00Z"), podOf("db-5", "sts-db", "other-claim"), // its pod mounts something else
		ownedByIt, ownedByAnother,
	)).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.ElementsMatch(t, []k8s.Conflict{
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-3", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-4", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-5", Namespace: "demo"}},
		{ObjectRef: k8s.ObjectRef{Kind: claimKind, Name: "data-db-8", Namespace: "demo"}},
	}, check.Conflicts)
	require.Empty(t, check.Unverified)
}

// Without pods to look at, a claim the StatefulSet does not own cannot be
// shown to be anyone's. One it owns needs no pods.
func TestCheckApply_OnUpdateClaimsThatNeedPodsTheCallerMayNotListAreUnverified(t *testing.T) {
	owned := claimBorn("data-db-1", "2026-09-03T00:00:00Z")
	owned.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "sts-db"}})
	dyn := cluster(runningDB(), claimBorn("data-db-0", "2026-09-03T00:00:00Z"), owned)
	dyn.PrependReactor("list", "pods", func(clientgotesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", errors.New("the role withholds list"))
	})
	check, err := k8s.NewForTest(dyn).CheckApply(context.Background(), relRef("db"), []byte(dbStatefulSet), false)
	require.NoError(t, err)
	require.Empty(t, check.Conflicts)
	require.Equal(t, []k8s.ObjectRef{{Kind: claimKind, Name: "data-db-0", Namespace: "demo"}}, check.Unverified)
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
