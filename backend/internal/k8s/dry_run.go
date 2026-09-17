package k8s

import (
	"context"
	"fmt"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// DryRunCreate validates a new deployment without persisting or returning
// objects. Create deliberately avoids merging with/readback of existing Secrets.
// Existing names are a conflict, not a successful validation of an update.
func (c *Client) DryRunCreate(ctx context.Context, namespace string, manifest []byte) error {
	objs, err := splitYAML(manifest)
	if err != nil {
		return apierrors.NewBadRequest("invalid YAML")
	}
	if len(objs) == 0 || len(objs) > 50 {
		return apierrors.NewBadRequest("validation requires between 1 and 50 resources")
	}
	for _, obj := range objs {
		gvk := obj.GroupVersionKind()
		resource := pluralize(gvk.Kind)
		if resource == "" || !IsMVPResource(gvk.Group, resource) {
			return apierrors.NewBadRequest(fmt.Sprintf("unsupported resource %s", gvk.String()))
		}
		if err := placeInNamespace(obj, namespace); err != nil {
			return apierrors.NewBadRequest(err.Error())
		}
		if obj.GetName() == "" {
			return apierrors.NewBadRequest(fmt.Sprintf("%s requires metadata.name", gvk.Kind))
		}
	}
	for _, obj := range objs {
		gvk := obj.GroupVersionKind()
		gvr := schema.GroupVersionResource{Group: gvk.Group, Version: gvk.Version, Resource: pluralize(gvk.Kind)}
		_, err := c.dyn.Resource(gvr).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{
			DryRun: []string{metav1.DryRunAll}, FieldValidation: metav1.FieldValidationStrict, FieldManager: "kubeport",
		})
		if err != nil {
			return fmt.Errorf("%s/%s: %w", gvk.Kind, obj.GetName(), err)
		}
	}
	return nil
}
