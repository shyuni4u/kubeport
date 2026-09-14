package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// ApplyAll server-side applies every doc in a multi-document YAML stream into
// namespace. An object without metadata.namespace is placed there; one that
// names a different namespace is refused (see placeInNamespace). All documents
// are attempted even if some fail; errors are aggregated.
//
// It does not look at who owns what it overwrites. Call CheckApply first.
func (c *Client) ApplyAll(ctx context.Context, namespace string, multiDoc []byte) error {
	objs, err := splitYAML(multiDoc)
	if err != nil {
		return fmt.Errorf("split yaml: %w", err)
	}
	errs := make([]error, 0, len(objs))
	for _, o := range objs {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		gvk := o.GroupVersionKind()
		plural := pluralize(gvk.Kind)
		if plural == "" {
			errs = append(errs, fmt.Errorf("unsupported kind %q (MVP supports §12.1 only)", gvk.Kind))
			continue
		}
		if o.GetName() == "" {
			errs = append(errs, fmt.Errorf("object %s is missing metadata.name", gvk.Kind))
			continue
		}
		gvr := schema.GroupVersionResource{
			Group:    gvk.Group,
			Version:  gvk.Version,
			Resource: plural,
		}
		// Enforced here as well as in CheckApply because not every apply is
		// preceded by a check: UpdateRelease's rollback re-applies stored YAML.
		if err := placeInNamespace(o, namespace); err != nil {
			errs = append(errs, err)
			continue
		}
		buf, err := yaml.Marshal(o.Object)
		if err != nil {
			errs = append(errs, fmt.Errorf("marshal %s/%s/%s: %w", gvk.Kind, o.GetNamespace(), o.GetName(), err))
			continue
		}
		_, err = c.dyn.Resource(gvr).Namespace(o.GetNamespace()).Patch(
			ctx, o.GetName(), types.ApplyPatchType, buf,
			metav1.PatchOptions{FieldManager: "kubeport", Force: boolPtr(true)},
		)
		if err != nil {
			errs = append(errs, fmt.Errorf("apply %s/%s/%s: %w", gvk.Kind, o.GetNamespace(), o.GetName(), err))
			continue
		}
	}
	return errors.Join(errs...)
}

func boolPtr(b bool) *bool { return &b }

func splitYAML(src []byte) ([]*unstructured.Unstructured, error) {
	var out []*unstructured.Unstructured
	dec := utilyaml.NewYAMLToJSONDecoder(bytes.NewReader(src))
	for {
		u := &unstructured.Unstructured{}
		if err := dec.Decode(&u.Object); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
		if u.Object == nil {
			continue
		}
		out = append(out, u)
	}
	return out, nil
}

// kindToPlural covers only the §12.1 MVP kinds. Unknown kinds map to ""
// so the caller can surface a clear error.
var kindToPlural = map[string]string{
	"Deployment":            "deployments",
	"StatefulSet":           "statefulsets",
	"DaemonSet":             "daemonsets",
	"Job":                   "jobs",
	"CronJob":               "cronjobs",
	"Service":               "services",
	"Ingress":               "ingresses",
	"ConfigMap":             "configmaps",
	"Secret":                "secrets",
	"PersistentVolumeClaim": "persistentvolumeclaims",
}

func pluralize(kind string) string {
	return kindToPlural[kind]
}

// mvpResources lists the GVRs for all MVP-supported kinds.
var mvpResources = []schema.GroupVersionResource{
	{Group: "apps", Version: "v1", Resource: "deployments"},
	{Group: "apps", Version: "v1", Resource: "statefulsets"},
	{Group: "apps", Version: "v1", Resource: "daemonsets"},
	{Group: "batch", Version: "v1", Resource: "jobs"},
	{Group: "batch", Version: "v1", Resource: "cronjobs"},
	{Group: "", Version: "v1", Resource: "services"},
	{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	{Group: "", Version: "v1", Resource: "configmaps"},
	{Group: "", Version: "v1", Resource: "secrets"},
	{Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
}

// IsMVPResource reports whether (group, resource) is one kubeport itself
// manages. `mvpResources` is the single source of truth for that set, so the
// SSAR proxy can refuse to ask a cluster about anything kubeport would never
// apply (issue #73) without a second list drifting from this one.
//
// TODO(v1.1 CRDs, #103): widen this with the admin-registered CRD set when it
// exists — e.g. IsAllowedResource(group, resource, registered) — or the SSAR
// proxy refuses every CRD the deploy itself would apply.
func IsMVPResource(group, resource string) bool {
	for _, gvr := range mvpResources {
		if gvr.Group == group && gvr.Resource == resource {
			return true
		}
	}
	return false
}

// MVPResourceNames lists the same set as "group/resource", core group first as
// a bare name. A rejected request quotes it, so a client learns the allowed set
// from the error instead of guessing at it.
func MVPResourceNames() []string {
	out := make([]string, 0, len(mvpResources))
	for _, gvr := range mvpResources {
		if gvr.Group == "" {
			out = append(out, gvr.Resource)
			continue
		}
		out = append(out, gvr.Group+"/"+gvr.Resource)
	}
	sort.Strings(out)
	return out
}

// DeleteForbiddenError is a release delete the cluster refused on resources the
// release was applied with (#380): their objects are still there. Resources are
// the plural resource names, each once, in the order they were tried.
type DeleteForbiddenError struct {
	Resources []string
}

func (e *DeleteForbiddenError) Error() string {
	return "delete refused for " + strings.Join(e.Resources, ", ") + ": forbidden"
}

// DeleteByRelease deletes the release's MVP resources: those carrying its name
// and its id (#195). Selecting on the name alone also deleted objects of
// another release that shares the name — one under another registration of
// the same cluster, or one created after this release's delete left objects
// behind.
//
// A NameOnly release also has its objects with the name and no id deleted —
// how everything applied before #195 looks. For any other release those are
// someone else's (see ReleaseRef.NameOnly), including the cleanup of a create
// that failed.
//
// Still a delete-collection by label, not a list and a delete per object: the
// demo Role may delete Secrets it may not list.
//
// Background propagation: batch/v1 Jobs orphan their pods by default, and a
// Job's pods carry no id (its pod template is immutable), so an orphaned pod
// would outlive the release under its name alone.
//
// A refusal on a resource the release still has objects of fails the delete
// with a DeleteForbiddenError (#380): those objects are still in the cluster,
// and a nil here let the caller drop the release row and leave them with
// nothing pointing at them. applied is the manifest the release was last
// applied with; a resource it lists counts without asking. An update does not
// prune, so a resource it does not list can still hold the release's objects
// (an earlier version's, or one a failed update applied): that one is listed
// on the same selector, and counts if anything comes back. Nothing there, or
// a list refused too — a demo Role, which has neither verb on resources a
// release never used — is skipped, as is a NotFound on any.
func (c *Client) DeleteByRelease(ctx context.Context, ref ReleaseRef, applied []byte) error {
	namespace := ref.Namespace
	if ref.UID == "" {
		return errors.New("delete by release: no release id")
	}
	used := resourcesIn(applied)
	// Shared with StorageOnDelete, whose warning has to be about exactly what
	// this deletes (#340).
	selectors := releaseSelectors(ref)
	background := metav1.DeletePropagationBackground
	opts := metav1.DeleteOptions{PropagationPolicy: &background}
	errs := make([]error, 0, len(mvpResources))
	var refused []string
	for _, r := range mvpResources {
		for _, sel := range selectors {
			if err := ctx.Err(); err != nil {
				return deleteResult(append(errs, err), refused)
			}
			if err := c.dyn.Resource(r).Namespace(namespace).
				DeleteCollection(ctx, opts, metav1.ListOptions{LabelSelector: sel}); err != nil {
				switch {
				case apierrors.IsNotFound(err):
					// Already gone.
				case apierrors.IsForbidden(err):
					has, listErr := used[r.GroupResource()], error(nil)
					if !has {
						// RBAC-scoped callers (e.g. demo accounts, see
						// deploy/helm/kubeport/templates/demo-rbac.yaml) may lack
						// access to resources this release never used (no
						// networking group, no daemonsets/pvc, ...). Skipped
						// unless the release has objects there after all.
						has, listErr = c.releaseHas(ctx, r, namespace, sel)
					}
					switch {
					case listErr != nil:
						errs = append(errs, listErr)
					case has && (len(refused) == 0 || refused[len(refused)-1] != r.Resource):
						refused = append(refused, r.Resource)
					}
				default:
					errs = append(errs, fmt.Errorf("delete %s: %w", r.Resource, err))
				}
			}
		}
	}
	return deleteResult(errs, refused)
}

// releaseHas reports whether any object of r in namespace matches sel, for a
// delete of it the cluster refused. A list refused too, or not found, cannot
// say: false, as before #380. Any other failure is returned.
func (c *Client) releaseHas(ctx context.Context, r schema.GroupVersionResource, namespace, sel string) (bool, error) {
	list, err := c.dyn.Resource(r).Namespace(namespace).
		List(ctx, metav1.ListOptions{LabelSelector: sel, Limit: 1})
	switch {
	case apierrors.IsForbidden(err) || apierrors.IsNotFound(err):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("list %s after a refused delete: %w", r.Resource, err)
	}
	return len(list.Items) > 0, nil
}

// deleteResult is the refusals alone as a DeleteForbiddenError, so a caller
// can tell an RBAC verdict from a failure a retry may clear; with any other
// failure, all of them joined.
func deleteResult(errs []error, refused []string) error {
	if len(refused) == 0 {
		return errors.Join(errs...)
	}
	forbidden := &DeleteForbiddenError{Resources: refused}
	if len(errs) == 0 {
		return forbidden
	}
	return errors.Join(append(errs, forbidden)...)
}

// resourcesIn is the set of MVP resources a manifest's documents are. A
// manifest that does not parse, or none at all, names none: every refusal is
// then skipped, as before #380.
func resourcesIn(manifest []byte) map[schema.GroupResource]bool {
	objs, err := splitYAML(manifest)
	if err != nil {
		return nil
	}
	used := make(map[schema.GroupResource]bool, len(objs))
	for _, o := range objs {
		gvk := o.GroupVersionKind()
		if plural := pluralize(gvk.Kind); plural != "" {
			used[schema.GroupResource{Group: gvk.Group, Resource: plural}] = true
		}
	}
	return used
}
