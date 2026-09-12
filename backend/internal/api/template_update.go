package api

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/store"
)

// updateTemplateReq is a partial update: any omitted field keeps its current
// value. `tags: null` also keeps the existing value (COALESCE in SQL).
// Sending `tags: []` is how a caller clears tags.
type updateTemplateReq struct {
	DisplayName *string   `json:"display_name"`
	Description *string   `json:"description"`
	Tags        *[]string `json:"tags"`
}

// UpdateTemplate handles PATCH /v1/templates/:name. Edits mutable metadata
// (display_name / description / tags) on the `templates` row itself —
// separate from the per-version ui_state JSON written by POST .../versions.
// Auth: global template requires kubeport-admin; team template requires
// team editor OR kubeport-admin (both enforced by ensureTemplateEditor).
func (h *Handlers) UpdateTemplate(c *gin.Context) {
	name := c.Param("name")
	if _, ok := h.ensureTemplateEditor(c, name); !ok {
		return
	}

	var r updateTemplateReq
	if !bindJSON(c, &r) {
		return
	}
	if r.DisplayName == nil && r.Description == nil && r.Tags == nil {
		writeError(c, http.StatusBadRequest, "validation-error", "no fields to update")
		return
	}

	ctx := c.Request.Context()
	params := store.UpdateTemplateMetaParams{Name: name}
	if r.DisplayName != nil {
		// Reject whitespace-only names too; stored value preserves the caller's
		// original spacing so intentional leading/trailing characters survive.
		if strings.TrimSpace(*r.DisplayName) == "" {
			writeError(c, http.StatusBadRequest, "validation-error", "display_name cannot be empty")
			return
		}
		params.DisplayName = pgtype.Text{String: *r.DisplayName, Valid: true}
	}
	if r.Description != nil {
		params.Description = pgtype.Text{String: *r.Description, Valid: true}
	}
	if r.Tags != nil {
		params.Tags = *r.Tags
	}

	if _, err := h.deps.Store.UpdateTemplateMeta(ctx, params); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusNotFound, "not-found", "template "+name)
			return
		}
		log.Printf("UpdateTemplate %s: %v", name, err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to update template")
		return
	}

	// Re-fetch via GetTemplateByName so the response carries the enriched
	// shape (current_version + owning_team_name) the clients expect.
	updated, err := h.deps.Store.GetTemplateByName(ctx, name)
	if err != nil {
		// Concurrent delete between update + re-fetch: surface as 404 rather
		// than 500 so the client can distinguish "someone else deleted it"
		// from an actual server error.
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusNotFound, "not-found", "template "+name)
			return
		}
		log.Printf("UpdateTemplate GetTemplateByName %s: %v", name, err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to reload template")
		return
	}
	c.JSON(http.StatusOK, updated)
}
