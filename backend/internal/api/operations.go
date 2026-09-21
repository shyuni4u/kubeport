package api

import (
	"context"
	"errors"
	"log"
	"net/http"

	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation"
	"kubeport/internal/auth"
	"kubeport/internal/k8s"
)

type operationsClient interface {
	InspectOperations(context.Context, string, string) k8s.OperationSnapshot
	RunOperation(context.Context, k8s.OperationRequest) error
}

func (h *Handlers) operationClient(c *gin.Context) (K8sApplier, bool) {
	ctx := c.Request.Context()
	cl, err := h.deps.Store.GetClusterByName(ctx, c.Param("name"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(c, 404, "not-found", "cluster")
		return nil, false
	}
	if err != nil {
		internalError(c, "operations cluster", err)
		return nil, false
	}
	u, _ := auth.UserFrom(ctx)
	cli, err := h.deps.K8sFactory.NewWithToken(cl.ApiUrl, cl.CaBundle.String, u.IDToken)
	if err != nil {
		internalError(c, "operations client", err)
		return nil, false
	}
	return cli, true
}

func (h *Handlers) GetClusterSettings(c *gin.Context) {
	cl, err := h.deps.Store.GetClusterByName(c.Request.Context(), c.Param("name"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(c, 404, "not-found", "cluster")
		return
	}
	if err != nil {
		internalError(c, "cluster settings", err)
		return
	}
	c.JSON(200, cl)
}

func (h *Handlers) UpdateClusterSettings(c *gin.Context) {
	var req struct {
		DisplayName string    `json:"display_name"`
		CA          string    `json:"ca_bundle"`
		Issuer      string    `json:"oidc_issuer_url" binding:"required,url"`
		Namespace   string    `json:"default_namespace"`
		Updated     time.Time `json:"updated_at" binding:"required"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if err := validateCABundle(req.CA); err != nil {
		writeError(c, 400, "validation-error", err.Error())
		return
	}
	if len(validation.IsDNS1123Label(req.Namespace)) != 0 {
		writeError(c, 400, "validation-error", "valid default namespace required")
		return
	}
	ok, err := h.deps.Store.UpdateClusterSettings(c.Request.Context(), c.Param("name"), req.DisplayName, req.CA, req.Issuer, req.Namespace, req.Updated)
	if err != nil {
		internalError(c, "update cluster settings", err)
		return
	}
	if !ok {
		writeError(c, 409, "conflict", "settings changed or cluster does not exist; refresh first")
		return
	}
	u, _ := auth.UserFrom(c.Request.Context())
	log.Printf("id=%s operation=cluster-settings actor=%q cluster=%q", requestIDFrom(c), u.Email, c.Param("name"))
	c.JSON(200, gin.H{"updated": true})
}

func (h *Handlers) DiagnoseCluster(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	cli, ok := h.operationClient(c)
	if !ok {
		return
	}
	namespace := c.Query("namespace")
	if namespace == "" {
		namespace = "default"
	}
	if len(validation.IsDNS1123Label(namespace)) != 0 {
		writeError(c, 400, "validation-error", "valid namespace required")
		return
	}
	out := map[string]bool{}
	for _, ch := range []struct{ key, group, resource, verb, ns string }{{"pods", "", "pods", "list", namespace}, {"deploy", "apps", "deployments", "create", namespace}, {"nodes", "", "nodes", "list", ""}, {"cordon", "", "nodes", "patch", ""}, {"storage", "", "persistentvolumeclaims", "create", namespace}, {"routing", "networking.k8s.io", "ingresses", "create", namespace}} {
		access, err := cli.CheckAccess(ctx, k8s.AccessCheck{Namespace: ch.ns, Group: ch.group, Resource: ch.resource, Verb: ch.verb})
		if err != nil {
			logWithheld(c, "diagnose cluster", err)
			c.JSON(200, gin.H{"connection": k8s.OperationErrorCode(err), "permissions": out})
			return
		}
		out[ch.key] = access.Allowed
	}
	c.JSON(200, gin.H{"connection": "connected", "permissions": out})
}

func (h *Handlers) InspectOperations(c *gin.Context) {
	area, ns := c.Query("area"), c.Query("namespace")
	if !onlyQuery(c, "area", "namespace") {
		return
	}
	if area != "nodes" && area != "storage" && area != "network" {
		writeError(c, 400, "validation-error", "area must be nodes, storage or network")
		return
	}
	if area == "nodes" && !isAdmin(c) {
		writeError(c, 403, "rbac-denied", "app admin required for node operations")
		return
	}
	if area == "nodes" {
		// This area lists every namespace and decides eviction per pod (#437),
		// so there is nothing for a namespace to mean here. Drop it at the
		// boundary rather than carrying an unvalidated string inwards and
		// relying on the node branch never reading it. Not a 400: a browser on
		// the previous bundle still sends one, and openapi says it is ignored.
		ns = ""
	} else if len(validation.IsDNS1123Label(ns)) != 0 {
		writeError(c, 400, "validation-error", "one valid namespace is required")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	cli, ok := h.operationClient(c)
	if !ok {
		return
	}
	ops, ok := cli.(operationsClient)
	if !ok {
		writeError(c, 500, "internal", "operations unavailable")
		return
	}
	c.JSON(200, ops.InspectOperations(ctx, area, ns))
}

func (h *Handlers) RunOperation(c *gin.Context) {
	var req k8s.OperationRequest
	if !bindJSON(c, &req) {
		return
	}
	switch req.Action {
	case "cordon", "uncordon", "evict", "publish-storage", "publish-ingress":
		if !isAdmin(c) {
			writeError(c, 403, "rbac-denied", "app admin required for infrastructure changes")
			return
		}
	case "create-pvc", "attach-pvc", "create-ingress", "create-storage-app":
	default:
		writeError(c, 400, "validation-error", "unsupported operation")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	cli, ok := h.operationClient(c)
	if !ok {
		return
	}
	ops, ok := cli.(operationsClient)
	if !ok {
		writeError(c, 500, "internal", "operations unavailable")
		return
	}
	// Serialize convenience writes across replicas. This closes the gap
	// between host/PVC checks and creation for other requests through kubeport.
	cl, err := h.deps.Store.GetClusterByName(ctx, c.Param("name"))
	if err != nil {
		internalError(c, "operations lock target", err)
		return
	}
	unlock, err := h.deps.Store.LockApply(ctx, "operations:"+normalizeAPIURL(cl.ApiUrl))
	if err != nil {
		internalError(c, "operations lock", err)
		return
	}
	defer unlock()
	err = ops.RunOperation(ctx, req)
	u, _ := auth.UserFrom(ctx)
	log.Printf("id=%s operation=%q actor=%q cluster=%q namespace=%q resource=%q success=%t", requestIDFrom(c), req.Action, u.Email, c.Param("name"), req.Namespace, req.Name, err == nil)
	if err != nil {
		if apierrors.IsForbidden(err) {
			writeError(c, 403, "rbac-denied", "Kubernetes RBAC denied the operation")
			return
		}
		if apierrors.IsUnauthorized(err) {
			writeError(c, 401, "unauthenticated", "cluster rejected the identity")
			return
		}
		if apierrors.IsTooManyRequests(err) {
			writeError(c, 409, "conflict", "eviction delayed by PDB or API rate limit; refresh before retrying")
			return
		}
		if apierrors.IsConflict(err) || apierrors.IsAlreadyExists(err) {
			writeError(c, 409, "conflict", "resource changed or already exists; refresh first")
			return
		}
		var invalid *k8s.OperationValidationError
		if errors.As(err, &invalid) {
			writeError(c, 400, "validation-error", invalid.Error())
			return
		}
		upstreamError(c, "cluster operation", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"accepted": true})
}
