package api

import (
	"fmt"

	"github.com/gin-gonic/gin"

	"kubeport/internal/auth"
)

// openapiView is how much of a cluster's OpenAPI surface a caller reads.
//
// The proxy has no admin gate: any signed-in caller can point it at any
// registered cluster, and a cluster that trusts the same IdP serves /openapi
// to every authenticated user through the default system:discovery binding
// (confirmed on the live k3s, #283). So without a view of its own, anyone who
// can sign in with the IdP enumerates every group/version and installed CRD.
type openapiView uint8

const (
	// openapiViewFull is the whole surface, CRDs included — for the callers
	// who can author templates: a kubeport admin on a non-demo account, or an
	// editor of at least one team. Their kind autocomplete must reach the CRDs
	// an operator registered (v1.1 scope).
	openapiViewFull openapiView = iota
	// openapiViewBuiltin is every other signed-in caller (#283).
	openapiViewBuiltin
	// openapiViewDemo is a demo account, admin or not (#124). The demo line
	// comes first, as everywhere else: the demo accounts carry kubeport-admin.
	openapiViewDemo
)

// builtinOpenAPIGroupVersions holds the group/versions of the built-in
// workload kinds the MVP resource scope names — Deployment, StatefulSet,
// DaemonSet, Job, CronJob, Service, Ingress, ConfigMap, Secret and
// PersistentVolumeClaim. A caller who cannot author templates has no editor to
// autocomplete in; this is what is left for them to read without learning
// which CRDs the cluster runs.
var builtinOpenAPIGroupVersions = map[string]bool{
	"v1":                   true,
	"apps/v1":              true,
	"batch/v1":             true,
	"networking.k8s.io/v1": true,
}

// groupVersions is the allowlist for the view, or nil when nothing is hidden.
func (v openapiView) groupVersions() map[string]bool {
	switch v {
	case openapiViewDemo:
		return demoOpenAPIGroupVersions
	case openapiViewBuiltin:
		return builtinOpenAPIGroupVersions
	default:
		return nil
	}
}

// openapiViewFor decides the caller's view. The team lookup runs on every
// request, cache hits included: the cache key carries the view, so a caller
// who gains or loses the editor role reads the matching entry at once rather
// than the one stored under their old role.
func (h *Handlers) openapiViewFor(c *gin.Context) (openapiView, error) {
	if h.isDemoCaller(c) {
		return openapiViewDemo, nil
	}
	if isAdmin(c) {
		return openapiViewFull, nil
	}
	u, _ := auth.UserFrom(c.Request.Context())
	editor, err := h.deps.Store.IsTeamEditorBySubject(c.Request.Context(), u.Subject)
	if err != nil {
		return openapiViewBuiltin, fmt.Errorf("IsTeamEditorBySubject: %w", err)
	}
	if editor {
		return openapiViewFull, nil
	}
	return openapiViewBuiltin, nil
}
