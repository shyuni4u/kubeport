package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sort"

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
func (c *Client) DeleteByRelease(ctx context.Context, ref ReleaseRef) error {
	namespace, release, releaseUID := ref.Namespace, ref.Name, ref.UID
	if releaseUID == "" {
		return errors.New("delete by release: no release id")
	}
	selectors := []string{ReleaseLabel + "=" + release + "," + ReleaseUIDLabel + "=" + releaseUID}
	if ref.NameOnly {
		selectors = append(selectors, ReleaseLabel+"="+release+",!"+ReleaseUIDLabel)
	}
	background := metav1.DeletePropagationBackground
	opts := metav1.DeleteOptions{PropagationPolicy: &background}
	errs := make([]error, 0, len(mvpResources))
	for _, r := range mvpResources {
		for _, sel := range selectors {
			if err := ctx.Err(); err != nil {
				return errors.Join(append(errs, err)...)
			}
			if err := c.dyn.Resource(r).Namespace(namespace).
				DeleteCollection(ctx, opts, metav1.ListOptions{LabelSelector: sel}); err != nil {
				// RBAC-scoped callers (e.g. demo accounts, see
				// deploy/helm/kubeport/templates/demo-rbac.yaml) may lack access
				// to resource groups/kinds this release never actually used
				// (no networking group, no daemonsets/pvc, ...). Skip those
				// instead of failing the whole release delete; a resource that's
				// simply already gone is likewise not an error here.
				if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
					continue
				}
				errs = append(errs, fmt.Errorf("delete %s: %w", r.Resource, err))
			}
		}
	}
	return errors.Join(errs...)
}
