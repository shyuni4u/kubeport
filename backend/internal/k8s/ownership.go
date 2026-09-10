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
// select on it.
const ReleaseLabel = "kubeport.io/release"

// ReleaseUIDLabel carries the owning release's database id. A name alone was
// not an identity (#195): a deleted release frees its name while objects it
// could not delete still carry it, and the same apiserver registered under two
// cluster names lets two releases share one. The id is a label, not only an
// annotation, because deleting has to select on it — the demo Role may
// delete-collection Secrets it may not list.
const ReleaseUIDLabel = "kubeport.io/release-uid"

// heldBy reports whether labels mark an object as this release's own, and
// whether it carries this release's name under another release's id.
//
// An object without an id was applied before #195. On an update it is the
// release's own — the name is unique within the release's cluster and
// namespace, and this apply stamps the id on it. On a create it cannot be:
// the release has just been inserted, so an object already carrying its name
// was left by an earlier release of that name.
func heldBy(labels map[string]string, release, uid string, creating bool) (own, sameName bool) {
	if labels[ReleaseLabel] != release {
		return false, false
	}
	got := labels[ReleaseUIDLabel]
	switch {
	case uid != "" && got == uid:
		return true, false
	case got == "" && !creating:
		return true, false
	default:
		return false, true
	}
}

// belongsTo is heldBy for reading a release's state: an object with the
// release's name counts unless it carries another release's id.
func belongsTo(labels map[string]string, release, uid string) bool {
	if labels[ReleaseLabel] != release {
		return false
	}
	got := labels[ReleaseUIDLabel]
	return got == "" || got == uid
}

// ObjectRef names one object a rendered release would apply.
type ObjectRef struct {
	Kind      string
	Name      string
	Namespace string
}

func (r ObjectRef) String() string { return r.Kind + "/" + r.Name }

// Conflict is an object a release would overwrite without owning it. Owner is
// the release in the object's kubeport.io/release label, or "" when it carries
// none, meaning kubeport did not create it. OwnerUnknown marks an object the
// caller may not read but that was shown to exist (see CheckApply): its Owner
// is "" because nobody could look, not because it has none.
type Conflict struct {
	ObjectRef
	Owner        string
	OwnerUnknown bool
	// SameName marks an object whose Owner is this release's own name under
	// another release's id: left by an earlier release of that name, or held
	// by a release of that name under another registration of this cluster
	// (#195).
	SameName bool
}

// ApplyCheck is what CheckApply found.
type ApplyCheck struct {
	// Conflicts would be taken over by applying. Server-side apply with
	// Force rewrites the owner label as it goes, and from then on
	// DeleteByRelease and ListInstances treat the object as the new release's
	// (#161).
	Conflicts []Conflict
	// Unverified could not be checked at all. See CheckApply for why these do
	// not block.
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
// does not own, without changing anything. creating says whether the release
// is being created rather than updated. It has to run before the first apply,
// not inside it: a create that fails partway is cleaned up with
// DeleteByRelease, and if it had already relabelled someone else's object that
// cleanup deletes the other release's resource.
//
// An object the caller may write but not read cannot be checked by reading it.
// The demo Role grants create and patch on Secrets with get and list withheld
// on purpose (deploy/helm/kubeport/templates/demo-rbac.yaml), so refusing on
// that would make every template with a Secret undeployable for such a caller.
//
// On a create, existence can still be learned without read access. A
// server-side dry-run create needs only the create permission the apply needs
// anyway, and answers AlreadyExists for an object that is there — which cannot
// belong to a release that does not exist yet, so it is a conflict whose owner
// could not be read. It asks the apiserver nothing the caller could not ask it
// directly with the same token. This is what closes the cleanup path above for
// write-only callers.
//
// On an update that probe cannot tell the release's own object from anyone
// else's, and neither can one the dry run itself refuses, so those objects are
// Unverified and the caller should log them. That is tolerable because the
// whole manifest is checked before anything is applied and the loop keeps
// going past an unverified object — one readable conflict anywhere refuses the
// release — and because an update has no delete-on-failure cleanup. What gets
// through is an update whose only colliding objects are unreadable to the
// caller; it takes those over, which is no wider than before this check
// existed.
//
// The check and the apply are separate calls, so two requests racing for the
// same names can both pass (#191). Closing that needs the apiserver to
// arbitrate — a field manager per release, with Force off — which every
// existing release, applied under the single "kubeport" manager, would
// conflict with on update.
//
// releaseUID is the release's database id; an object is the release's own only
// when it carries that id, or — on an update — no id at all (see heldBy).
func (c *Client) CheckApply(ctx context.Context, namespace, release, releaseUID string, multiDoc []byte, creating bool) (ApplyCheck, error) {
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
			labels := existing.GetLabels()
			if own, sameName := heldBy(labels, release, releaseUID, creating); !own {
				out.Conflicts = append(out.Conflicts, Conflict{ObjectRef: ref, Owner: labels[ReleaseLabel], SameName: sameName})
			}
		case apierrors.IsNotFound(err):
			// Free to create.
		case apierrors.IsForbidden(err):
			if !creating {
				out.Unverified = append(out.Unverified, ref)
				continue
			}
			switch c.probeCreate(ctx, gvr, namespace, o) {
			case probeExists:
				out.Conflicts = append(out.Conflicts, Conflict{ObjectRef: ref, OwnerUnknown: true})
			case probeFree:
				// Nothing there to take.
			default:
				out.Unverified = append(out.Unverified, ref)
			}
		default:
			return out, fmt.Errorf("check %s: %w", ref, err)
		}
	}
	return out, nil
}

type probeResult int

const (
	probeUnknown probeResult = iota
	probeFree
	probeExists
)

// probeCreate asks the apiserver, with a dry run that persists nothing,
// whether o could be created. Anything but a clean answer is probeUnknown:
// the caller may lack create as well, or admission may refuse the object for
// reasons unrelated to whether it exists.
func (c *Client) probeCreate(ctx context.Context, gvr schema.GroupVersionResource, namespace string, o *unstructured.Unstructured) probeResult {
	_, err := c.dyn.Resource(gvr).Namespace(namespace).Create(ctx, o.DeepCopy(),
		metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}, FieldManager: "kubeport"})
	switch {
	case err == nil:
		return probeFree
	case apierrors.IsAlreadyExists(err):
		return probeExists
	default:
		return probeUnknown
	}
}
