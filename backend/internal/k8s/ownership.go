package k8s

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// ReleaseLabel names the release that owns an object. template.stampLabels
// writes it on every rendered object, and DeleteByRelease and ListInstances
// select on it. Ownership is by release name, which is unique within a
// cluster and namespace — the same scope an object lives in.
const ReleaseLabel = "kubeport.io/release"

// ObjectRef names one object a rendered release would apply.
type ObjectRef struct {
	Kind      string
	Name      string
	Namespace string
}

func (r ObjectRef) String() string { return r.Kind + "/" + r.Name }

// Conflict is an object a release would overwrite without owning it. Owner is
// the release in the object's kubeport.io/release label, or "" when it carries
// none, meaning kubeport did not create it.
type Conflict struct {
	ObjectRef
	Owner string
}

// ApplyCheck is what CheckApply found.
type ApplyCheck struct {
	// Conflicts would be taken over by applying. Server-side apply with
	// Force rewrites the owner label as it goes, and from then on
	// DeleteByRelease and ListInstances treat the object as the new release's
	// (#161).
	Conflicts []Conflict
	// Unverified could not be read, so their ownership is unknown. See
	// CheckApply for why these do not block.
	Unverified []ObjectRef
}

// NamespaceMismatchError is a rendered object that pins a namespace other than
// the release's. kubeport records the release's namespace and deletes and
// lists only there, so an object applied elsewhere is left behind when the
// release is deleted and never counted in its status (#137).
type NamespaceMismatchError struct {
	Object           ObjectRef // Namespace is the one the manifest pins
	ReleaseNamespace string
}

func (e *NamespaceMismatchError) Error() string {
	return fmt.Sprintf(
		"%s sets metadata.namespace %q, but the release is in %q: remove metadata.namespace from the template, or deploy the release into %q",
		e.Object, e.Object.Namespace, e.ReleaseNamespace, e.Object.Namespace)
}

// placeInNamespace puts an object in the release's namespace. An object that
// names a different one is refused rather than moved: relocating it silently
// would override what the template author wrote, and applying it where it asks
// is what orphans it.
func placeInNamespace(o *unstructured.Unstructured, namespace string) error {
	switch pinned := o.GetNamespace(); pinned {
	case "":
		o.SetNamespace(namespace)
		return nil
	case namespace:
		return nil
	default:
		return &NamespaceMismatchError{
			Object:           ObjectRef{Kind: o.GetKind(), Name: o.GetName(), Namespace: pinned},
			ReleaseNamespace: namespace,
		}
	}
}

// CheckApply reports what applying multiDoc as release would do to objects it
// does not own, without changing anything. It has to run before the first
// apply, not inside it: an apply that fails partway is cleaned up with
// DeleteByRelease, and if it had already relabelled someone else's object
// that cleanup deletes the other release's resource.
//
// An object the caller may write but not read is Unverified rather than a
// conflict. The demo Role grants create and patch on Secrets with get and list
// withheld on purpose (deploy/helm/kubeport/templates/demo-rbac.yaml), so
// refusing there would make every template with a Secret undeployable for such
// a caller. The caller should log them.
//
// That is safe only because the whole manifest is checked before anything is
// applied, and the loop keeps going past an unreadable object: one readable
// conflict anywhere refuses the release, unreadable objects and all. What gets
// through is a template whose only colliding objects are ones the caller
// cannot read, a lone Secret say. Such a release takes that object over, and
// if its apply then fails partway, the label-based cleanup deletes the other
// release's copy. That residue is no wider than it was before this check
// existed; closing it would mean locking those callers out of the kind.
//
// The check and the apply are separate calls, so two requests racing for the
// same names can both pass. Closing that needs the apiserver to arbitrate — a
// field manager per release, with Force off — which every existing release,
// applied under the single "kubeport" manager, would conflict with on update.
func (c *Client) CheckApply(ctx context.Context, namespace, release string, multiDoc []byte) (ApplyCheck, error) {
	var out ApplyCheck
	objs, err := splitYAML(multiDoc)
	if err != nil {
		return out, fmt.Errorf("split yaml: %w", err)
	}
	for _, o := range objs {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		gvk := o.GroupVersionKind()
		plural := pluralize(gvk.Kind)
		if plural == "" || o.GetName() == "" {
			// ApplyAll refuses these with its own message. Nothing can be
			// taken over by an object that cannot be applied.
			continue
		}
		if err := placeInNamespace(o, namespace); err != nil {
			return out, err
		}
		ref := ObjectRef{Kind: gvk.Kind, Name: o.GetName(), Namespace: namespace}
		gvr := schema.GroupVersionResource{Group: gvk.Group, Version: gvk.Version, Resource: plural}
		existing, err := c.dyn.Resource(gvr).Namespace(namespace).Get(ctx, o.GetName(), metav1.GetOptions{})
		switch {
		case err == nil:
			if owner := existing.GetLabels()[ReleaseLabel]; owner != release {
				out.Conflicts = append(out.Conflicts, Conflict{ObjectRef: ref, Owner: owner})
			}
		case apierrors.IsNotFound(err):
			// Free to create.
		case apierrors.IsForbidden(err):
			out.Unverified = append(out.Unverified, ref)
		default:
			return out, fmt.Errorf("check %s: %w", ref, err)
		}
	}
	return out, nil
}
