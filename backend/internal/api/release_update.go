package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"kubeport/internal/auth"
	"kubeport/internal/store"
	"kubeport/internal/template"
)

// updateReleaseReq is the body of PUT /v1/releases/:id.
//
// Template name, cluster, and namespace are NOT accepted here: those are
// immutable for an existing release. Changing them requires a new release.
// (Any such keys on the wire are silently ignored — Gin's default binding
// drops unknown fields.)
type updateReleaseReq struct {
	Version int             `json:"version" binding:"required,min=1"`
	Values  json.RawMessage `json:"values"  binding:"required"`
}

// UpdateRelease re-renders and re-applies an existing release with new
// values (and optionally a new template version).
//
// Authorization: admin OR the user who created the release.
//
// Ordering (apply → DB):
//
//  1. Fetch release row + capture old rendered_yaml for rollback.
//  2. Resolve the target template version by (template_id, version). Reject
//     deprecated (400) / unpublished (409) / unknown (400).
//  3. Render the new YAML — validation errors surface as 400.
//     Check the rendered objects' ownership — another release's objects →
//     409 resource-conflict, a pinned foreign namespace → 400 (#161, #137).
//  4. Apply new YAML to k8s — failure → 502 (DB untouched).
//  5. Update DB. If the UPDATE fails after a successful apply, re-apply
//     the old YAML to keep k8s and DB consistent, then return 500.
//
// This "apply-first" ordering mirrors how CreateRelease rolls back
// (CreateRelease inserts then applies; if apply fails, delete both).
// For an update there is no row to roll back — we restore prior state
// instead.
func (h *Handlers) UpdateRelease(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "invalid release id")
		return
	}

	var req updateReleaseReq
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	// Gin's `required` tag treats `null` as "present". Reject it explicitly
	// so a caller sending {"version":1,"values":null} can't silently reset
	// a release to template defaults.
	if len(req.Values) == 0 || bytes.Equal(bytes.TrimSpace(req.Values), []byte("null")) {
		writeError(c, http.StatusBadRequest, "validation-error", "values must be a JSON object")
		return
	}

	ctx := c.Request.Context()
	u, _ := auth.UserFrom(ctx)

	// Load the release; establishes immutable cluster/namespace/template name.
	rel, err := h.deps.Store.GetReleaseByID(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusNotFound, "not-found", "release")
			return
		}
		log.Printf("UpdateRelease GetReleaseByID: %v", err)
		writeError(c, http.StatusNotFound, "not-found", "release")
		return
	}

	// AuthZ: admin OR release creator (mirrors GetRelease / DeleteRelease).
	if !h.authorizeReleaseAccess(c, rel) {
		return
	}

	// Resolve the target version FOR THIS release's template. Going through
	// template name + version matches CreateRelease's pattern and ensures the
	// caller can't sneak in a version from a different template.
	tv, err := h.deps.Store.GetTemplateVersion(ctx, store.GetTemplateVersionParams{
		Name:    rel.TemplateName,
		Version: int32(req.Version),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusBadRequest, "validation-error",
				"unknown template version "+strconv.Itoa(req.Version)+" for template "+rel.TemplateName)
			return
		}
		log.Printf("UpdateRelease GetTemplateVersion: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to load template version")
		return
	}
	if !requireDeployableVersion(c, tv, rel.TemplateName) {
		return
	}

	// Render with new values. ReleaseID uses rel.Name for consistency with
	// CreateRelease (labels use the stable human name, not the UUID).
	rendered, err := template.Render(tv.ResourcesYaml, tv.UiSpecYaml, req.Values, template.Labels{
		ReleaseName:     rel.Name,
		TemplateName:    rel.TemplateName,
		TemplateVersion: req.Version,
		ReleaseID:       rel.Name,
		AppliedBy:       u.Email,
	})
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	// Apply to k8s BEFORE mutating DB. If apply fails we return 502 and DB is
	// still consistent (reflects the old, still-deployed, state).
	cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
	if err != nil {
		internalError(c, "UpdateRelease: k8s client", err)
		return
	}
	// A new version can add an object, and an exposed metadata.name can rename
	// one, so an update can land on another release's objects as readily as a
	// create can (#161).
	if !h.checkOwnership(c, cli, "UpdateRelease", rel.Namespace, rel.Name, rendered) {
		return
	}
	if err := cli.ApplyAll(ctx, rel.Namespace, rendered); err != nil {
		upstreamError(c, "UpdateRelease: apply", err)
		return
	}

	// DB update. On failure, try to re-apply the OLD rendered_yaml so k8s
	// reflects the committed DB state. Best-effort — log any rollback error.
	//
	// TODO(rollback-test): cover this branch with a unit test that forces
	// UpdateReleaseValuesAndVersion to fail and asserts (a) response is 500,
	// (b) fakeK8sApplier.applied contains the OLD rendered_yaml as its most
	// recent entry. Requires either extracting a narrow Store interface for
	// api.Deps (currently concrete *store.Store) or wrapping the pgxpool
	// with a "fail-next-exec" shim — either is >30 lines across routes.go +
	// test fixtures, outside Plan 3 Task 2's scope. Reviewer accepted a
	// deferred TODO per the Task 2 review notes.
	if err := h.deps.Store.UpdateReleaseValuesAndVersion(ctx, store.UpdateReleaseValuesAndVersionParams{
		ID:                id,
		TemplateVersionID: tv.ID,
		ValuesJson:        req.Values,
		RenderedYaml:      string(rendered),
	}); err != nil {
		log.Printf("UpdateRelease UpdateReleaseValuesAndVersion: %v", err)
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if rbErr := cli.ApplyAll(rollbackCtx, rel.Namespace, []byte(rel.RenderedYaml)); rbErr != nil {
			log.Printf("rollback: failed to re-apply old yaml for release %s: %v", rel.Name, rbErr)
		}
		writeError(c, http.StatusInternalServerError, "internal", "failed to update release")
		return
	}

	c.JSON(http.StatusOK, gin.H{"id": id, "version": req.Version})
}
