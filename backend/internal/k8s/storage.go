package k8s

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Storage is what deleting a release does to its storage (#340).
type Storage string

const (
	// StorageDeleted: a StatefulSet of the release deletes its claims with it
	// (whenDeleted: Delete), or the release carries claims of its own that the
	// delete removes directly. Under the usual reclaim policy the data goes too.
	StorageDeleted Storage = "deleted"
	// StorageKept: the release has StatefulSets with claims, and none deletes
	// them.
	StorageKept Storage = "kept"
	// StorageNone: nothing of the release holds storage.
	StorageNone Storage = "none"
	// StorageUnknown: the caller may not list the release's StatefulSets, so
	// nothing can be said.
	StorageUnknown Storage = "unknown"
)

var (
	storageSetsGVR   = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	storageClaimsGVR = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}
)

// releaseSelectors are the label selectors that pick a release's objects, as
// DeleteByRelease deletes them: its id, and for a NameOnly release also its
// name on objects without an id (#195).
func releaseSelectors(ref ReleaseRef) []string {
	selectors := []string{ReleaseLabel + "=" + ref.Name + "," + ReleaseUIDLabel + "=" + ref.UID}
	if ref.NameOnly {
		selectors = append(selectors, ReleaseLabel+"="+ref.Name+",!"+ReleaseUIDLabel)
	}
	return selectors
}

// StorageOnDelete says what DeleteByRelease would do to the release's storage
// right now, for the delete confirmation to say before the click (#340).
//
// It reads the cluster, not the manifest the release was last applied with.
// An update applies without pruning, so a StatefulSet a later version dropped
// is still there under the release's labels — and, rendered with the Delete
// default, still deletes its claims when the release goes. The manifest does
// not show it; the same selectors DeleteByRelease uses do (security review).
//
// Claims carrying the release's labels are deleted by DeleteByRelease itself,
// with the caller's token, and a refused delete-collection is skipped there.
// Whether the caller may delete them is a separate grant from whether it may
// list them (codex review), so the cluster is asked (claimDeletion), once:
//   - claims listed: deleted if it may delete them; left to the StatefulSets'
//     verdict if it may not, since they stay; unknown if nobody can say.
//   - claims not listable: left to the StatefulSets' verdict only if it may
//     not delete them — the demo user Role withholds both — else unknown.
func (c *Client) StorageOnDelete(ctx context.Context, ref ReleaseRef) (Storage, error) {
	if ref.UID == "" {
		return StorageUnknown, errors.New("storage on delete: no release id")
	}
	verdict := StorageNone
	unknown := false
	access := claimsUnasked
	deletion := func() claimAccess {
		if access == claimsUnasked {
			access = c.claimDeletion(ctx, ref.Namespace)
		}
		return access
	}
	for _, sel := range releaseSelectors(ref) {
		opts := metav1.ListOptions{LabelSelector: sel}
		sets, err := c.dyn.Resource(storageSetsGVR).Namespace(ref.Namespace).List(ctx, opts)
		switch {
		case apierrors.IsForbidden(err):
			return StorageUnknown, nil
		case err != nil:
			return StorageUnknown, fmt.Errorf("list statefulsets: %w", err)
		}
		for _, set := range sets.Items {
			templates, _, _ := unstructured.NestedSlice(set.Object, "spec", "volumeClaimTemplates")
			if len(templates) == 0 {
				continue
			}
			if when, _, _ := unstructured.NestedString(set.Object, "spec", "persistentVolumeClaimRetentionPolicy", "whenDeleted"); when == "Delete" {
				return StorageDeleted, nil
			}
			verdict = StorageKept
		}
		claims, err := c.dyn.Resource(storageClaimsGVR).Namespace(ref.Namespace).List(ctx, opts)
		switch {
		case apierrors.IsForbidden(err):
			if deletion() != claimsNotDeletable {
				unknown = true
			}
		case err != nil:
			return StorageUnknown, fmt.Errorf("list persistentvolumeclaims: %w", err)
		case len(claims.Items) > 0:
			switch deletion() {
			case claimsDeletable:
				return StorageDeleted, nil
			case claimsAccessUnknown:
				unknown = true
			}
			// claimsNotDeletable: the delete leaves them where they are.
		}
	}
	// A StatefulSet that deletes its claims has returned above whatever the
	// claims said: its controller deletes them, not the caller.
	if unknown {
		return StorageUnknown, nil
	}
	return verdict, nil
}

type claimAccess int

const (
	claimsUnasked claimAccess = iota
	claimsDeletable
	claimsNotDeletable
	claimsAccessUnknown
)

// claimDeletion asks the cluster whether the caller may delete-collection
// claims in namespace — what DeleteByRelease does to them. An error, or a
// client that cannot ask, is neither answer.
func (c *Client) claimDeletion(ctx context.Context, namespace string) claimAccess {
	if c.cs == nil {
		return claimsAccessUnknown
	}
	res, err := c.CheckAccess(ctx, AccessCheck{Namespace: namespace, Verb: "deletecollection", Resource: "persistentvolumeclaims"})
	switch {
	case err != nil:
		return claimsAccessUnknown
	case res.Allowed:
		return claimsDeletable
	default:
		return claimsNotDeletable
	}
}
