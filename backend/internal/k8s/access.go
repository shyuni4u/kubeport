package k8s

import (
	"context"

	authv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AccessCheck describes a single "can I do verb on resource?" question to be
// answered by the target cluster's authorizer (via SelfSubjectAccessReview).
//
// Fields map 1:1 onto authorizationv1.ResourceAttributes. All fields are
// optional from this type's perspective; the handler layer decides which are
// required (Verb + Resource for the HTTP endpoint).
type AccessCheck struct {
	Namespace string
	Verb      string
	Group     string
	Resource  string
	Name      string
}

// AccessResult is the cluster's answer to an AccessCheck.
//
// Allowed and Denied are both booleans because the k8s authorizer can
// explicitly deny (RBAC deny rule) as distinct from "no rule matched".
// Reason is a human-readable explanation populated by the authorizer
// (e.g. "RBAC: role foo grants ... / no rules allow ...").
type AccessResult struct {
	Allowed bool
	Denied  bool
	Reason  string
}

// CheckAccess asks the target cluster whether the caller (identified by the
// bearer token used to build this Client) may perform spec.Verb on the
// resource described by spec. The cluster runs its normal authorizer chain
// (RBAC, webhooks, ...) and returns the combined verdict.
//
// Used by the deploy form to surface apply-time denials before submit.
func (c *Client) CheckAccess(ctx context.Context, spec AccessCheck) (AccessResult, error) {
	review := &authv1.SelfSubjectAccessReview{
		Spec: authv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authv1.ResourceAttributes{
				Namespace: spec.Namespace,
				Verb:      spec.Verb,
				Group:     spec.Group,
				Resource:  spec.Resource,
				Name:      spec.Name,
			},
		},
	}
	out, err := c.cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
	if err != nil {
		return AccessResult{}, err
	}
	return AccessResult{
		Allowed: out.Status.Allowed,
		Denied:  out.Status.Denied,
		Reason:  out.Status.Reason,
	}, nil
}
