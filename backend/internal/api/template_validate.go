package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"kubeport/internal/auth"
	"kubeport/internal/template"
)

type validateTemplateReq struct {
	Resources string          `json:"resources_yaml" binding:"required"`
	UISpec    string          `json:"ui_spec_yaml" binding:"required"`
	Values    json.RawMessage `json:"values"`
	Cluster   string          `json:"cluster" binding:"required"`
	Namespace string          `json:"namespace" binding:"required"`
	Name      string          `json:"name" binding:"required"`
}

// ValidateTemplate checks the caller's unsaved template and input on a selected
// cluster. It never stores a template/release or returns apiserver objects.
func (h *Handlers) ValidateTemplate(c *gin.Context) {
	view, err := h.openapiViewFor(c)
	if err != nil {
		internalError(c, "ValidateTemplate: editor", err)
		return
	}
	if view != openapiViewFull {
		writeError(c, http.StatusForbidden, "rbac-denied", "template editor permission required")
		return
	}
	var r validateTemplateReq
	if !bindJSON(c, &r) {
		return
	}
	if problem := releaseTargetProblem(r.Namespace, r.Name); problem != "" {
		writeError(c, 400, "validation-error", problem)
		return
	}
	if err := template.ValidateSpec(r.Resources, r.UISpec); err != nil {
		writeError(c, 400, "validation-error", err.Error())
		return
	}
	if len(r.Values) == 0 {
		r.Values = json.RawMessage(`{}`)
	}
	manifest, err := template.Render(r.Resources, r.UISpec, r.Values, template.Labels{ReleaseName: r.Name, ReleaseID: uuid.NewString(), Namespace: r.Namespace})
	if err != nil {
		renderProblem(c, err)
		return
	}
	if overBudget(c, h.releaseWrite) {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	cluster, err := h.deps.Store.GetClusterByName(ctx, r.Cluster)
	if err != nil {
		writeError(c, 404, "not-found", "cluster")
		return
	}
	user, _ := auth.UserFrom(ctx)
	client, err := h.deps.K8sFactory.NewWithToken(cluster.ApiUrl, cluster.CaBundle.String, user.IDToken)
	if err != nil {
		internalError(c, "ValidateTemplate: client", err)
		return
	}
	validator, ok := client.(interface {
		DryRunCreate(context.Context, string, []byte) error
	})
	if !ok {
		writeError(c, 500, "internal", "cluster validation unavailable")
		return
	}
	if err := validator.DryRunCreate(ctx, r.Namespace, manifest); err != nil {
		switch {
		case apierrors.IsForbidden(err):
			writeError(c, 403, "rbac-denied", err.Error())
		case apierrors.IsUnauthorized(err):
			writeError(c, 403, "cluster-auth-denied", "cluster rejected the login; sign in again")
		case apierrors.IsInvalid(err), apierrors.IsBadRequest(err), apierrors.IsAlreadyExists(err), apierrors.IsNotFound(err):
			writeError(c, 400, "validation-error", err.Error())
		default:
			internalError(c, "ValidateTemplate: dry-run", err)
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"valid": true})
}
