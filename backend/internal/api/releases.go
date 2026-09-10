package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/k8s"
	"kubeport/internal/store"
	"kubeport/internal/template"
)

const defaultPageLimit = 50

type createReleaseReq struct {
	Template  string          `json:"template"  binding:"required"`
	Version   int             `json:"version"   binding:"required,min=1"`
	Cluster   string          `json:"cluster"   binding:"required"`
	Namespace string          `json:"namespace" binding:"required"`
	Name      string          `json:"name"      binding:"required,hostname_rfc1123"`
	Values    json.RawMessage `json:"values"    binding:"required"`
}

// resolveUser upserts the authenticated user and returns the DB record.
// NOTE: This does NOT participate in a database transaction. Callers inside
// Store.WithTx blocks (e.g. CreateTemplate) should use the transactional
// Queries directly instead of this helper.
func (h *Handlers) resolveUser(c *gin.Context) (store.User, bool) {
	u, _ := auth.UserFrom(c.Request.Context())
	user, err := h.deps.Store.UpsertUser(c.Request.Context(), store.UpsertUserParams{
		OidcSubject: u.Subject,
		Email:       store.PgText(u.Email),
		DisplayName: store.PgText(u.Name),
	})
	if err != nil {
		internalError(c, "resolveUser", err)
		return store.User{}, false
	}
	return user, true
}

// isAdmin returns true if the authenticated user belongs to kubeport-admin.
func isAdmin(c *gin.Context) bool {
	u, _ := auth.UserFrom(c.Request.Context())
	for _, g := range u.Groups {
		if g == "kubeport-admin" {
			return true
		}
	}
	return false
}

// authorizeReleaseAccess returns true if the caller is an admin or the release's
// creator. On denial it writes a 403 response and returns false. Callers that
// already loaded the release should use this before touching k8s / DB so the
// same rule is applied everywhere (Get/Delete/Update/Logs).
func (h *Handlers) authorizeReleaseAccess(c *gin.Context, rel store.GetReleaseByIDRow) bool {
	if isAdmin(c) {
		// Demo admins keep admin UX but only over demo-owned releases.
		if h.isDemoCaller(c) {
			demoOwned, err := h.isDemoOwnedRelease(c.Request.Context(), rel.CreatedByUserID)
			if err != nil {
				log.Printf("authorizeReleaseAccess: resolve owner: %v", err)
				writeError(c, http.StatusInternalServerError, "internal", "failed to resolve release owner")
				return false
			}
			if !demoOwned {
				writeError(c, http.StatusForbidden, "demo-restricted",
					"demo accounts can only access demo-owned releases")
				return false
			}
		}
		return true
	}
	user, ok := h.resolveUser(c)
	if !ok {
		// resolveUser already wrote a 500.
		return false
	}
	if rel.CreatedByUserID != user.ID {
		writeError(c, http.StatusForbidden, "rbac-denied", "not the release owner")
		return false
	}
	return true
}

// requireDeployableVersion writes an error response and returns false when the
// given template version is not in a state that can back a new or updated
// release. Shared by CreateRelease and UpdateRelease so the status gate is
// defined in exactly one place.
//
// templateName is passed explicitly because store.TemplateVersion does not
// carry it (sqlc row shape) and the error message wants to identify the
// template.
func requireDeployableVersion(c *gin.Context, tv store.TemplateVersion, templateName string) bool {
	if tv.Status == "deprecated" {
		writeError(c, http.StatusBadRequest, "validation-error",
			"template "+templateName+" v"+strconv.Itoa(int(tv.Version))+" is deprecated; pick a non-deprecated version")
		return false
	}
	if tv.Status != "published" {
		writeError(c, http.StatusConflict, "conflict", "version not published")
		return false
	}
	return true
}

// parsePagination extracts limit/offset from query params with defaults.
func parsePagination(c *gin.Context) (limit, offset int32) {
	limit = defaultPageLimit
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 32); err == nil && n > 0 && n <= 200 {
			limit = int32(n)
		}
	}
	if v := c.Query("offset"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 32); err == nil && n >= 0 {
			offset = int32(n)
		}
	}
	return
}

func (h *Handlers) CreateRelease(c *gin.Context) {
	var r createReleaseReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	if problem := releaseTargetProblem(r.Namespace, r.Name); problem != "" {
		writeError(c, http.StatusBadRequest, "validation-error", problem)
		return
	}
	ctx := c.Request.Context()
	u, _ := auth.UserFrom(ctx)

	tv, err := h.deps.Store.GetTemplateVersion(ctx, store.GetTemplateVersionParams{
		Name:    r.Template,
		Version: int32(r.Version),
	})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}
	if !requireDeployableVersion(c, tv, r.Template) {
		return
	}

	cluster, err := h.deps.Store.GetClusterByName(ctx, r.Cluster)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "cluster")
		return
	}

	// ReleaseID uses r.Name rather than DB UUID because the UUID is not known
	// until after INSERT. The release name is unique within (cluster, namespace)
	// and is used as the kubeport.io/release label for k8s resource tracking.
	rendered, err := template.Render(tv.ResourcesYaml, tv.UiSpecYaml, r.Values, template.Labels{
		ReleaseName:     r.Name,
		TemplateName:    r.Template,
		TemplateVersion: r.Version,
		ReleaseID:       r.Name,
		AppliedBy:       u.Email,
	})
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	caBundle := cluster.CaBundle.String
	cli, err := h.deps.K8sFactory.NewWithToken(cluster.ApiUrl, caBundle, u.IDToken)
	if err != nil {
		internalError(c, "CreateRelease: k8s client", err)
		return
	}

	user, ok := h.resolveUser(c)
	if !ok {
		return
	}

	// The row comes before the ownership check, and the check before the first
	// apply (#161). In that order:
	//
	//   - A release that already exists is answered by the unique constraint as
	//     the name clash it is (409 conflict). The other way round, its own
	//     objects answered first: for a caller who may write a Secret but not
	//     read it, the dry-run probe reports AlreadyExists, that reads as a
	//     resource-conflict, and the demo seeder's ordinary re-run failed
	//     instead of skipping the release it had already made (codex review).
	//     The constraint also settles two creates of the same name racing.
	//   - Nothing has been applied when the check refuses, so undoing the
	//     refusal is deleting this row. That is the only state in which the
	//     failed-apply cleanup below cannot delete another release's objects:
	//     it deletes by label, and an apply that got partway had already
	//     relabelled whatever it overwrote.
	rel, err := h.deps.Store.InsertRelease(ctx, store.InsertReleaseParams{
		Name:              r.Name,
		TemplateVersionID: tv.ID,
		ClusterID:         cluster.ID,
		Namespace:         r.Namespace,
		ValuesJson:        r.Values,
		RenderedYaml:      string(rendered),
		CreatedByUserID:   user.ID,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			writeError(c, http.StatusConflict, "conflict", "release name already exists in this cluster/namespace")
			return
		}
		log.Printf("InsertRelease error: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to create release")
		return
	}
	if !h.checkOwnership(c, cli, "CreateRelease", r.Namespace, r.Name, rendered) {
		// checkOwnership has answered. Remove the row it refused, so no release
		// is left claiming objects that were never applied.
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if delErr := h.deps.Store.DeleteRelease(rollbackCtx, rel.ID); delErr != nil {
			log.Printf("rollback: failed to delete refused release %s from DB: %v", rel.Name, delErr)
		}
		return
	}
	if err := cli.ApplyAll(ctx, r.Namespace, rendered); err != nil {
		// Clean up partially created k8s resources with an independent context
		// and a timeout so cleanup doesn't hang indefinitely.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if delErr := cli.DeleteByRelease(cleanupCtx, r.Namespace, r.Name); delErr != nil {
			log.Printf("rollback: failed to delete k8s resources for release %s: %v", r.Name, delErr)
		}
		if delErr := h.deps.Store.DeleteRelease(cleanupCtx, rel.ID); delErr != nil {
			log.Printf("rollback: failed to delete release %s from DB: %v", rel.Name, delErr)
		}
		// The apply failing is usually the cluster's authorizer saying no. That
		// is the event an operator needs to be able to look up later — "who
		// tried to deploy what, where, and was refused" — and it used to leave
		// no trace at all (#72). The access log has the request id; this line
		// has the target.
		log.Printf("release apply failed id=%s user=%s cluster=%s ns=%s release=%s: %v",
			requestIDFrom(c), u.Email, cluster.Name, r.Namespace, r.Name, err)
		upstreamError(c, "CreateRelease: apply", err)
		return
	}
	c.JSON(http.StatusCreated, rel)
}

// isDemoCaller reports whether the authenticated caller is a demo-domain
// account. Demo accounts are granted kubeport-admin (they must be able to
// author templates for the demo) but their admin powers are deliberately
// scoped to demo-owned objects - see internal/api/permissions.go.
func (h *Handlers) isDemoCaller(c *gin.Context) bool {
	u, _ := auth.UserFrom(c.Request.Context())
	return auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain)
}

// isDemoOwnedRelease reports whether the release was created by a demo-domain
// user. The bool is only meaningful when err == nil.
func (h *Handlers) isDemoOwnedRelease(ctx context.Context, createdBy pgtype.UUID) (bool, error) {
	owner, err := h.deps.Store.GetUserByID(ctx, createdBy)
	if err != nil {
		return false, err
	}
	return auth.IsDemoEmail(owner.Email.String, h.deps.DemoEmailDomain), nil
}

func (h *Handlers) ListReleases(c *gin.Context) {
	ctx := c.Request.Context()
	limit, offset := parsePagination(c)

	// A demo admin gets an admin-shaped list, but scoped to releases created
	// by demo accounts - never a real user's workloads.
	if isAdmin(c) && h.isDemoCaller(c) {
		rows, err := h.deps.Store.ListReleasesForDemoDomain(ctx, store.ListReleasesForDemoDomainParams{
			Domain: h.deps.DemoEmailDomain, Lim: limit, Off: offset,
		})
		if err != nil {
			internalError(c, "ListReleases (demo scope)", err)
			return
		}
		if rows == nil {
			rows = []store.ListReleasesForDemoDomainRow{}
		}
		c.JSON(http.StatusOK, gin.H{"releases": rows})
		return
	}

	if isAdmin(c) {
		rows, err := h.deps.Store.ListAllReleases(ctx, store.ListAllReleasesParams{
			Limit: limit, Offset: offset,
		})
		if err != nil {
			internalError(c, "ListReleases (admin)", err)
			return
		}
		if rows == nil {
			rows = []store.ListAllReleasesRow{}
		}
		c.JSON(http.StatusOK, gin.H{"releases": rows})
		return
	}

	user, ok := h.resolveUser(c)
	if !ok {
		return
	}
	rows, err := h.deps.Store.ListReleasesForUser(ctx, store.ListReleasesForUserParams{
		CreatedByUserID: user.ID, Limit: limit, Offset: offset,
	})
	if err != nil {
		internalError(c, "ListReleases", err)
		return
	}
	if rows == nil {
		rows = []store.ListReleasesForUserRow{}
	}
	c.JSON(http.StatusOK, gin.H{"releases": rows})
}

func (h *Handlers) GetRelease(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "invalid release id")
		return
	}
	ctx := c.Request.Context()
	rel, err := h.deps.Store.GetReleaseByID(ctx, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "release")
		return
	}

	if !h.authorizeReleaseAccess(c, rel) {
		return
	}

	u, ok := auth.UserFrom(ctx)
	if !ok {
		respondReleaseOverview(c, rel, nil, "unknown")
		return
	}
	cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
	if err != nil {
		respondReleaseOverview(c, rel, nil, "cluster-unreachable")
		return
	}

	instances, err := cli.ListInstances(ctx, rel.Namespace, rel.Name)
	if err != nil {
		respondReleaseOverview(c, rel, nil, "cluster-unreachable")
		return
	}
	if len(instances) == 0 {
		respondReleaseOverview(c, rel, instances, "resources-missing")
		return
	}

	respondReleaseOverview(c, rel, instances, "")
}

// respondReleaseOverview writes the release detail response. statusOverride
// pins a specific status string (Plan 8: "cluster-unreachable" /
// "resources-missing" / "unknown" for the no-auth fallback) — pass "" to
// fall back to instance-derived `abstractStatus`. The instances field is
// normalized to [] (never null) so JSON consumers can call .map / .reduce
// without defensive coercion.
func respondReleaseOverview(c *gin.Context, rel store.GetReleaseByIDRow, instances []k8s.Instance, statusOverride string) {
	if instances == nil {
		instances = []k8s.Instance{}
	}
	ready := 0
	for _, i := range instances {
		if i.Ready {
			ready++
		}
	}
	status := statusOverride
	if status == "" {
		status = abstractStatus(instances)
	}
	c.JSON(http.StatusOK, gin.H{
		"id": rel.ID, "name": rel.Name,
		"template":        gin.H{"name": rel.TemplateName, "version": rel.TemplateVersion},
		"cluster":         rel.ClusterName,
		"namespace":       rel.Namespace,
		"values_json":     rel.ValuesJson,
		"rendered_yaml":   rel.RenderedYaml,
		"instances_total": len(instances),
		"instances_ready": ready,
		"instances":       instances,
		"status":          status,
		"created_at":      rel.CreatedAt,
	})
}

// abstractStatus derives a summary status from pod instances.
func abstractStatus(instances []k8s.Instance) string {
	const maxRestartsBeforeError = 5
	if len(instances) == 0 {
		return "unknown"
	}
	allReady := true
	hasError := false
	for _, i := range instances {
		if !i.Ready && i.Phase != "Succeeded" {
			allReady = false
		}
		if i.Phase == "Failed" || i.Restarts > maxRestartsBeforeError {
			hasError = true
		}
	}
	if hasError {
		return "error"
	}
	if allReady {
		return "healthy"
	}
	return "warning"
}

func (h *Handlers) DeleteRelease(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "invalid release id")
		return
	}
	ctx := c.Request.Context()
	u, _ := auth.UserFrom(ctx)

	// Plan 8 escape hatch: when the cluster is unreachable or its workloads
	// have been externally removed, an admin needs to clean up the orphan
	// DB row without going through k8s. Restricted to admins because it
	// bypasses the safety check that "release exists in cluster" — letting
	// non-admin owners do this would let them lose track of running
	// workloads on a transient network blip.
	force := c.Query("force") == "true"
	if force && !isAdmin(c) {
		writeError(c, http.StatusForbidden, "rbac-denied", "force delete requires admin")
		return
	}
	if force {
		if auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
			writeError(c, http.StatusForbidden, "demo-restricted", "demo accounts cannot force-delete")
			return
		}
	}

	rel, err := h.deps.Store.GetReleaseByID(ctx, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "release")
		return
	}

	if !h.authorizeReleaseAccess(c, rel) {
		return
	}

	if !force {
		cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
		if err != nil {
			internalError(c, "DeleteRelease: k8s client", err)
			return
		}
		if err := cli.DeleteByRelease(ctx, rel.Namespace, rel.Name); err != nil {
			upstreamError(c, "DeleteRelease: delete resources", err)
			return
		}
	} else {
		// Audit trail until a real audit log exists. The operator email +
		// release id + name + cluster is the minimum to reconstruct who
		// removed what. We log the raw URL param rather than the parsed
		// `id` because `pgtype.UUID` doesn't implement `fmt.Stringer`, so
		// `%s` would dump the struct fields instead of the canonical UUID
		// text.
		log.Printf("force-delete: user=%s release_id=%s name=%s cluster=%s",
			u.Email, c.Param("id"), rel.Name, rel.ClusterName)
	}

	if err := h.deps.Store.DeleteRelease(ctx, id); err != nil {
		internalError(c, "DeleteRelease", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "force": force})
}

func parseUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return u, fmt.Errorf("invalid uuid: %w", err)
	}
	return u, nil
}
