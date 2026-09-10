package k8s

import (
	"context"
	"encoding/json"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

// StampLeftBehind gives ref's id to objects of the previous manifest that the
// next one no longer renders, for a release being updated for the first time
// since #195 (ref.NameOnly).
//
// That update stamps the id on everything it applies, and from then on the
// release is not NameOnly: its delete selects by id only. An update does not
// prune, so an object the new version dropped — or renamed, through an exposed
// metadata.name — stays in the cluster with the release's name and no id, and
// the release's delete would leave it running, where the name-only delete
// before #195 removed it (codex review). Stamping it here keeps it the
// release's.
//
// Only an object that still carries ref's name and no id is stamped: one with
// another release's id, or another name, is not this release's to claim. An
// object the caller may write but not read — a demo Secret — cannot be checked
// that way, and skipping it left exactly that Secret behind on delete (security
// review). It gets a JSON patch whose test op requires ref's name label, so the
// apiserver refuses it (422) for an object with another name. A gone object is
// nothing to stamp. Any other error is returned, and the caller should not go
// on: the id fallback would be dropped with objects still unstamped.
func (c *Client) StampLeftBehind(ctx context.Context, ref ReleaseRef, previous, next []byte) error {
	if ref.UID == "" {
		return fmt.Errorf("stamp left-behind objects: no release id")
	}
	prevObjs, err := splitYAML(previous)
	if err != nil {
		return fmt.Errorf("split previous yaml: %w", err)
	}
	nextObjs, err := splitYAML(next)
	if err != nil {
		return fmt.Errorf("split next yaml: %w", err)
	}
	kept := map[string]bool{}
	for _, o := range nextObjs {
		kept[o.GetKind()+"/"+o.GetName()] = true
	}
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"labels": map[string]string{ReleaseUIDLabel: ref.UID}},
	})
	if err != nil {
		return err
	}
	// "~1" is "/" in a JSON pointer.
	guarded, err := json.Marshal([]map[string]any{
		{"op": "test", "path": "/metadata/labels/kubeport.io~1release", "value": ref.Name},
		{"op": "add", "path": "/metadata/labels/kubeport.io~1release-uid", "value": ref.UID},
	})
	if err != nil {
		return err
	}

	for _, o := range prevObjs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if kept[o.GetKind()+"/"+o.GetName()] {
			continue // the update applies it, with the id
		}
		plural := pluralize(o.GetKind())
		if plural == "" || o.GetName() == "" {
			continue
		}
		if pinned := o.GetNamespace(); pinned != "" && pinned != ref.Namespace {
			continue // never applied into the release's namespace (#137)
		}
		gvk := o.GroupVersionKind()
		res := c.dyn.Resource(schema.GroupVersionResource{Group: gvk.Group, Version: gvk.Version, Resource: plural}).
			Namespace(ref.Namespace)
		existing, err := res.Get(ctx, o.GetName(), metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			continue
		case apierrors.IsForbidden(err):
			_, err := res.Patch(ctx, o.GetName(), types.JSONPatchType, guarded, metav1.PatchOptions{FieldManager: "kubeport"})
			switch {
			case err == nil, apierrors.IsNotFound(err), apierrors.IsInvalid(err):
				// Stamped; gone; or the test op found another name.
			default:
				return fmt.Errorf("stamp %s/%s: %w", o.GetKind(), o.GetName(), err)
			}
			continue
		case err != nil:
			return fmt.Errorf("read %s/%s: %w", o.GetKind(), o.GetName(), err)
		}
		labels := existing.GetLabels()
		if labels[ReleaseLabel] != ref.Name || labels[ReleaseUIDLabel] != "" {
			continue
		}
		if _, err := res.Patch(ctx, o.GetName(), types.MergePatchType, patch,
			metav1.PatchOptions{FieldManager: "kubeport"}); err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("stamp %s/%s: %w", o.GetKind(), o.GetName(), err)
		}
	}
	return nil
}
