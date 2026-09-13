package k8s

import (
	"context"
	"fmt"
	"strings"

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

// ReleaseRef identifies one release's objects in a cluster.
type ReleaseRef struct {
	Namespace string
	Name      string
	// UID is the release's database id, carried in ReleaseUIDLabel.
	UID string
	// NameOnly marks a release whose objects were last applied before
	// ReleaseUIDLabel existed: they carry its name and no id. Only such a
	// release counts an object without an id as its own. For any other, that
	// object is someone else's — an earlier release of the same name, or one
	// under another registration of the cluster (#195). A NameOnly release
	// stops being one when an update stamps its objects.
	NameOnly bool
}

// heldBy reports whether labels mark an object as ref's own, and whether it
// carries ref's name under another identity.
//
// An object without an id counts only for a NameOnly release, and only on an
// update, which stamps the id on it. A create has just inserted the release,
// so an object already carrying its name was left by an earlier release.
func heldBy(labels map[string]string, ref ReleaseRef, creating bool) (own, sameName bool) {
	if labels[ReleaseLabel] != ref.Name {
		return false, false
	}
	got := labels[ReleaseUIDLabel]
	switch {
	case ref.UID != "" && got == ref.UID:
		return true, false
	case got == "" && ref.NameOnly && !creating:
		return true, false
	default:
		return false, true
	}
}

// belongsTo is heldBy for reading a release's state.
func belongsTo(labels map[string]string, ref ReleaseRef) bool {
	if labels[ReleaseLabel] != ref.Name {
		return false
	}
	got := labels[ReleaseUIDLabel]
	return (ref.UID != "" && got == ref.UID) || (got == "" && ref.NameOnly)
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
// An object is ref's own when it carries ref's id, or — for a NameOnly release
// on an update — no id at all (see heldBy).
func (c *Client) CheckApply(ctx context.Context, rel ReleaseRef, multiDoc []byte, creating bool) (ApplyCheck, error) {
	namespace := rel.Namespace
	var out ApplyCheck
	// StatefulSets by what the cluster holds under their names, for checkClaims:
	// added are not there yet, running are the release's own as the cluster has
	// them, unreadable are ones an update's caller may not read.
	added, unreadable := map[string]bool{}, map[string]bool{}
	running := map[string]*unstructured.Unstructured{}
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
			if own, sameName := heldBy(labels, rel, creating); !own {
				out.Conflicts = append(out.Conflicts, Conflict{ObjectRef: ref, Owner: labels[ReleaseLabel], SameName: sameName})
			} else if isStatefulSet(gvk) {
				running[o.GetName()] = existing
			}
		case apierrors.IsNotFound(err):
			// Free to create.
			if isStatefulSet(gvk) {
				added[o.GetName()] = true
			}
		case apierrors.IsForbidden(err):
			if !creating {
				out.Unverified = append(out.Unverified, ref)
				if isStatefulSet(gvk) {
					unreadable[o.GetName()] = true
				}
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
	if err := c.checkClaims(ctx, namespace, objs, creating, added, unreadable, running, &out); err != nil {
		return out, err
	}
	return out, nil
}

var claimsGVR = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}

func isStatefulSet(gvk schema.GroupVersionKind) bool {
	return gvk.Group == "apps" && gvk.Kind == "StatefulSet"
}

// checkClaims adds the claims a release's StatefulSets would take over without
// having made them.
//
// They are not in the manifest, so the loop above never sees them. A
// StatefulSet whose claims go with it (whenDeleted: Delete, which Render
// defaults, #340) makes its controller the owner of every claim named
// <claim>-<statefulset>-<ordinal> that no other controller owns — including
// one that was there before it. Deleting the release then deletes that claim,
// and with the usual reclaim policy its volume: a claim an earlier release of
// the same name kept, one another release chose to retain, or one made outside
// kubeport. Before the default the same collision only mounted the other data;
// now it destroys it, so such a claim is a conflict.
//
// On a create, and for a StatefulSet an update adds (a new version, a renamed
// object), every matching claim was there first. For a StatefulSet the release
// already runs, a claim is its own only on evidence (evidentlyOwn); any other
// is a conflict. That includes the claim it was deployed next to — under
// Retain, or before the default existed — and has mounted since, which turning
// Delete on would take (security review), and one waiting at an ordinal a
// scale-up would add (codex review).
//
// Every ordinal counts, not just the StatefulSet's current replicas, so
// scaling up later cannot reach a claim that was there when it arrived. A
// StatefulSet held by another release is a conflict already and is skipped.
//
// One list serves every StatefulSet. A caller who may not list claims — the
// demo's user account — cannot be checked, nor can a StatefulSet an update's
// caller may not read; those names are Unverified, as for any unreadable
// object.
func (c *Client) checkClaims(ctx context.Context, namespace string, objs []*unstructured.Unstructured, creating bool,
	added, unreadable map[string]bool, running map[string]*unstructured.Unstructured, out *ApplyCheck) error {
	var check []claimTemplate
	for _, t := range claimTemplates(objs) {
		_, isRunning := running[t.set]
		switch {
		case creating || added[t.set] || isRunning:
			check = append(check, t)
		case unreadable[t.set]:
			out.Unverified = append(out.Unverified, t.ref(namespace))
		}
	}
	if len(check) == 0 {
		return nil
	}
	claims, err := c.dyn.Resource(claimsGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	switch {
	case apierrors.IsForbidden(err):
		for _, t := range check {
			out.Unverified = append(out.Unverified, t.ref(namespace))
		}
		return nil
	case err != nil:
		return fmt.Errorf("check claims: %w", err)
	}
	for _, claim := range claims.Items {
		for _, t := range check {
			ordinal, ok := strings.CutPrefix(claim.GetName(), t.prefix)
			if !ok || !isOrdinal(ordinal) {
				continue
			}
			if sts, isRunning := running[t.set]; isRunning && !creating && evidentlyOwn(&claim, sts, ordinal) {
				break
			}
			out.Conflicts = append(out.Conflicts, Conflict{
				ObjectRef: ObjectRef{Kind: "PersistentVolumeClaim", Name: claim.GetName(), Namespace: namespace},
				Owner:     claim.GetLabels()[ReleaseLabel],
			})
			break
		}
	}
	return nil
}

// evidentlyOwn reports whether claim, which matches a claim template of the
// release's running StatefulSet sts at ordinal, is shown to be sts's own.
//
// Either sts already owns it — its controller does under Delete, and a claim a
// scale-down left keeps that — or a pod of sts mounts it: its ordinal is one of
// sts's current replicas, and it is not older than sts. The controller makes a
// pod's claim once sts exists, so an older claim at that ordinal is one sts was
// deployed next to.
//
// Creation time alone is not enough (codex review): a claim made after sts at
// an ordinal beyond its replicas is mounted by nothing yet, and a scale-up
// would take it.
func evidentlyOwn(claim, sts *unstructured.Unstructured, ordinal string) bool {
	if uid := sts.GetUID(); uid != "" {
		for _, ref := range claim.GetOwnerReferences() {
			if ref.UID == uid {
				return true
			}
		}
	}
	if len(ordinal) > 18 {
		return false // past any replica count, and past int64
	}
	var n int64
	for _, r := range ordinal {
		n = n*10 + int64(r-'0')
	}
	start, _, _ := unstructured.NestedInt64(sts.Object, "spec", "ordinals", "start")
	replicas, found, _ := unstructured.NestedInt64(sts.Object, "spec", "replicas")
	if !found {
		replicas = 1
	}
	if n < start || n >= start+replicas {
		return false
	}
	made, since := claim.GetCreationTimestamp(), sts.GetCreationTimestamp()
	return !made.Before(&since)
}

// claimTemplate is one claim template of a StatefulSet whose claims are
// deleted with it.
type claimTemplate struct {
	set    string // the StatefulSet's name
	prefix string // "<claim>-<set>-"
}

func (t claimTemplate) ref(namespace string) ObjectRef {
	return ObjectRef{Kind: "PersistentVolumeClaim", Name: t.prefix + "<ordinal>", Namespace: namespace}
}

// claimTemplates lists them for every StatefulSet in objs. The ordinal after
// the prefix is what tells data-db-0 (claim data of db) from data-db-x-0
// (claim data of db-x).
func claimTemplates(objs []*unstructured.Unstructured) []claimTemplate {
	var out []claimTemplate
	for _, o := range objs {
		if !isStatefulSet(o.GroupVersionKind()) || o.GetName() == "" {
			continue
		}
		if when, _, _ := unstructured.NestedString(o.Object, "spec", "persistentVolumeClaimRetentionPolicy", "whenDeleted"); when != "Delete" {
			continue
		}
		templates, _, _ := unstructured.NestedSlice(o.Object, "spec", "volumeClaimTemplates")
		for _, tmpl := range templates {
			m, ok := tmpl.(map[string]any)
			if !ok {
				continue
			}
			if name, _, _ := unstructured.NestedString(m, "metadata", "name"); name != "" {
				out = append(out, claimTemplate{set: o.GetName(), prefix: name + "-" + o.GetName() + "-"})
			}
		}
	}
	return out
}

func isOrdinal(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
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
