package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// ApplyAll server-side applies every doc in a multi-document YAML stream.
// Objects without metadata.namespace inherit the namespace argument.
// All documents are attempted even if some fail; errors are aggregated.
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
		if o.GetNamespace() == "" {
			o.SetNamespace(namespace)
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

// DeleteByRelease deletes all MVP resources matching the kubeport.io/release label.
func (c *Client) DeleteByRelease(ctx context.Context, namespace, release string) error {
	sel := "kubeport.io/release=" + release
	errs := make([]error, 0, len(mvpResources))
	for _, r := range mvpResources {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if err := c.dyn.Resource(r).Namespace(namespace).
			DeleteCollection(ctx, metav1.DeleteOptions{}, metav1.ListOptions{LabelSelector: sel}); err != nil {
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
	return errors.Join(errs...)
}
