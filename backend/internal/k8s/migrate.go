package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

// StampLeftBehind gives ref's id to the objects a release from before #195
// (ref.NameOnly) owns by its name alone, ahead of its first update since.
//
// That update stamps the id on everything it applies, and from then on the
// release is not NameOnly: its delete selects by id only. An object it does
// not apply stays in the cluster with the release's name and no id, and the
// release's delete would leave it running, where the name-only delete before
// #195 removed it. Such an object is one the new version drops or renames,
// through an exposed metadata.name (codex review), or one an update before
// #195 had already dropped, which no manifest still names (codex review).
//
// They are found two ways, since the demo Role may patch objects it may not
// list or read (Secrets):
//   - for every kind kubeport manages that the caller may list, by the
//     selector the name-only delete used: release=<name>,!release-uid. This
//     also finds what the update applies anyway, which stamping first does not
//     change;
//   - the objects of the previous manifest that the next one no longer
//     renders, by name.
//
// An object of a kind the caller may not list, dropped before #195, is found
// neither way and is left behind on delete.
//
// Each is stamped by a JSON patch whose test ops require ref's name label and
// no id label, so the apiserver refuses it (422) for an object that is not,
// as it is patched, this release's by name alone: one with another name, or
// with another release's id (codex and security review). A gone object is
// nothing to stamp. Any other error is returned, and the caller should not go
// on: the name-only fallback would be dropped with objects still unstamped.
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
	// A null value tests that the label is absent — checked against a v1.35
	// apiserver, which refuses the patch for an object carrying any id.
	guarded, err := json.Marshal([]map[string]any{
		{"op": "test", "path": labelPointer(ReleaseLabel), "value": ref.Name},
		{"op": "test", "path": labelPointer(ReleaseUIDLabel), "value": nil},
		{"op": "add", "path": labelPointer(ReleaseUIDLabel), "value": ref.UID},
	})
	if err != nil {
		return err
	}
	done := map[schema.GroupVersionResource]map[string]bool{}
	stamp := func(gvr schema.GroupVersionResource, name string) error {
		if done[gvr][name] {
			return nil
		}
		_, err := c.dyn.Resource(gvr).Namespace(ref.Namespace).
			Patch(ctx, name, types.JSONPatchType, guarded, metav1.PatchOptions{FieldManager: "kubeport"})
		switch {
		case err == nil, apierrors.IsNotFound(err), refusedByTest(err):
			// Stamped; gone; or not this release's by name alone.
		default:
			return fmt.Errorf("stamp %s/%s: %w", gvr.Resource, name, err)
		}
		if done[gvr] == nil {
			done[gvr] = map[string]bool{}
		}
		done[gvr][name] = true
		return nil
	}

	selector := ReleaseLabel + "=" + ref.Name + ",!" + ReleaseUIDLabel
	for _, gvr := range mvpResources {
		if err := ctx.Err(); err != nil {
			return err
		}
		list, err := c.dyn.Resource(gvr).Namespace(ref.Namespace).
			List(ctx, metav1.ListOptions{LabelSelector: selector})
		switch {
		case apierrors.IsForbidden(err), apierrors.IsNotFound(err):
			continue // not listable here: only the previous manifest finds these
		case err != nil:
			return fmt.Errorf("list %s: %w", gvr.Resource, err)
		}
		for _, item := range list.Items {
			if err := stamp(gvr, item.GetName()); err != nil {
				return err
			}
		}
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
		gvr := schema.GroupVersionResource{Group: gvk.Group, Version: gvk.Version, Resource: plural}
		if err := stamp(gvr, o.GetName()); err != nil {
			return err
		}
	}
	return nil
}

// refusedByTest reports whether a patch was refused because it could not be
// applied — for the guarded patch, whose ops are fixed, because a test op
// failed. The apiserver answers that 422 with no details and a generic message
// (checked against v1.35, for a failed test and a missing path alike). A 422
// that names the object or its causes is something else — the patched object
// failing validation, or an admission policy — and is not a verdict that the
// object is another release's: skipping it would leave the object unstamped
// (security review). So is an admission webhook's refusal, which keeps the
// webhook's code and reason but gets no details, only a message prefix.
func refusedByTest(err error) bool {
	var status apierrors.APIStatus
	if !apierrors.IsInvalid(err) || !errors.As(err, &status) {
		return false
	}
	if strings.HasPrefix(status.Status().Message, "admission webhook ") {
		return false
	}
	d := status.Status().Details
	return d == nil || (d.Name == "" && d.Kind == "" && len(d.Causes) == 0)
}

// labelPointer is the JSON pointer to a label key: "~" and "/" are escaped as
// "~0" and "~1".
func labelPointer(key string) string {
	return "/metadata/labels/" + strings.NewReplacer("~", "~0", "/", "~1").Replace(key)
}
