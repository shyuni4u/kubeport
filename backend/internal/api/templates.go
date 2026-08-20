package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/store"
	"kubeport/internal/template"
)

type createTemplateReq struct {
	Name          string   `json:"name"           binding:"required"`
	DisplayName   string   `json:"display_name"   binding:"required"`
	Description   string   `json:"description"`
	Tags          []string `json:"tags"`
	AuthoringMode string   `json:"authoring_mode" binding:"required,oneof=yaml ui"`
	OwningTeamID  string   `json:"owning_team_id"` // uuid or ""

	// When mode=yaml:
	ResourcesYAML string `json:"resources_yaml"`
	UISpecYAML    string `json:"ui_spec_yaml"`

	// When mode=ui:
	UIState *template.UIModeTemplate `json:"ui_state"`

	MetadataYAML string `json:"metadata_yaml"`
}

func (h *Handlers) CreateTemplate(c *gin.Context) {
	var r createTemplateReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	// authoring_mode / payload consistency.
	switch r.AuthoringMode {
	case "ui":
		if r.UIState == nil {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui requires ui_state")
			return
		}
		if r.ResourcesYAML != "" || r.UISpecYAML != "" {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui must not send resources_yaml/ui_spec_yaml")
			return
		}
		res, spec, err := template.SerializeUIMode(*r.UIState)
		if err != nil {
			writeError(c, http.StatusBadRequest, "validation-error", err.Error())
			return
		}
		r.ResourcesYAML = res
		r.UISpecYAML = spec
	case "yaml":
		if r.UIState != nil {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml must not send ui_state")
			return
		}
		if r.ResourcesYAML == "" || r.UISpecYAML == "" {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml requires resources_yaml + ui_spec_yaml")
			return
		}
	}

	// spec dry-run (both modes). Parses resources + ui-spec YAML; skips
	// required-field enforcement (those are checked at release deploy time).
	if err := template.ValidateSpec(r.ResourcesYAML, r.UISpecYAML); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	ctx := c.Request.Context()
	u, _ := auth.UserFrom(ctx)

	var owning pgtype.UUID
	if r.OwningTeamID != "" {
		parsed, err := uuid.Parse(r.OwningTeamID)
		if err != nil {
			writeError(c, http.StatusBadRequest, "validation-error", "owning_team_id must be a uuid")
			return
		}
		owning = pgtype.UUID{Bytes: parsed, Valid: true}
	}

	// Auth: global templates (no owning team) require kubeport-admin.
	// Team templates: delegate to ensureTeamEditor (admin OR team editor).
	if !owning.Valid {
		if !isKubeportAdmin(u) {
			writeError(c, http.StatusForbidden, "rbac-denied", "global template requires kubeport-admin")
			return
		}
	} else if !h.ensureTeamEditor(c, owning) {
		return
	}

	var uiStateJSON []byte
	if r.UIState != nil {
		b, _ := json.Marshal(r.UIState)
		uiStateJSON = b
	}

	var user store.User
	var tpl store.Template
	var ver store.TemplateVersion
	err := h.deps.Store.WithTx(ctx, func(q *store.Queries) error {
		var err error
		user, err = q.UpsertUser(ctx, store.UpsertUserParams{
			OidcSubject: u.Subject,
			Email:       store.PgText(u.Email),
			DisplayName: store.PgText(u.Name),
		})
		if err != nil {
			return err
		}

		tpl, err = q.InsertTemplateV2(ctx, store.InsertTemplateV2Params{
			Name:         r.Name,
			DisplayName:  r.DisplayName,
			Description:  store.PgText(r.Description),
			Tags:         r.Tags,
			OwnerUserID:  user.ID,
			OwningTeamID: owning,
		})
		if err != nil {
			return err
		}

		ver, err = q.InsertTemplateVersionV2(ctx, store.InsertTemplateVersionV2Params{
			TemplateID:      tpl.ID,
			Version:         1,
			ResourcesYaml:   r.ResourcesYAML,
			UiSpecYaml:      r.UISpecYAML,
			MetadataYaml:    store.PgText(r.MetadataYAML),
			Status:          "draft",
			CreatedByUserID: user.ID,
			AuthoringMode:   r.AuthoringMode,
			UiStateJson:     uiStateJSON,
		})
		return err
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			writeError(c, http.StatusConflict, "conflict", "template name already exists")
			return
		}
		log.Printf("CreateTemplate: %v", err) // server-side only
		writeError(c, http.StatusInternalServerError, "internal", "failed to create template")
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"template":       tpl,
		"version":        ver,
		"resources_yaml": r.ResourcesYAML,
		"ui_spec_yaml":   r.UISpecYAML,
	})
}

func (h *Handlers) ListTemplates(c *gin.Context) {
	rows, err := h.deps.Store.ListTemplates(c.Request.Context())
	if err != nil {
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if rows == nil {
		rows = []store.ListTemplatesRow{}
	}
	c.JSON(http.StatusOK, gin.H{"templates": rows})
}

func (h *Handlers) GetTemplate(c *gin.Context) {
	t, err := h.deps.Store.GetTemplateByName(c.Request.Context(), c.Param("name"))
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template")
		return
	}
	c.JSON(http.StatusOK, t)
}

func (h *Handlers) ListTemplateVersions(c *gin.Context) {
	vs, err := h.deps.Store.ListTemplateVersions(c.Request.Context(), c.Param("name"))
	if err != nil {
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if vs == nil {
		vs = []store.TemplateVersion{}
	}
	c.JSON(http.StatusOK, gin.H{"versions": vs})
}

func (h *Handlers) GetTemplateVersion(c *gin.Context) {
	v64, err := strconv.ParseInt(c.Param("v"), 10, 32)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "version must be integer")
		return
	}
	tv, err := h.deps.Store.GetTemplateVersion(c.Request.Context(), store.GetTemplateVersionParams{
		Name:    c.Param("name"),
		Version: int32(v64),
	})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}
	c.JSON(http.StatusOK, tv)
}

func (h *Handlers) PublishVersion(c *gin.Context) {
	ctx := c.Request.Context()
	if _, ok := h.ensureTemplateEditor(c, c.Param("name")); !ok {
		return
	}
	v64, err := strconv.ParseInt(c.Param("v"), 10, 32)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "version must be integer")
		return
	}
	existing, err := h.deps.Store.GetTemplateVersion(ctx, store.GetTemplateVersionParams{
		Name:    c.Param("name"),
		Version: int32(v64),
	})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}

	var published store.TemplateVersion
	var notDraft bool
	err = h.deps.Store.WithTx(ctx, func(q *store.Queries) error {
		pub, err := q.PublishTemplateVersion(ctx, existing.ID)
		if err != nil {
			notDraft = true
			return err
		}
		published = pub
		return q.UpdateTemplateCurrentVersion(ctx, store.UpdateTemplateCurrentVersionParams{
			ID:               existing.TemplateID,
			CurrentVersionID: pub.ID,
		})
	})
	if err != nil {
		if notDraft {
			writeError(c, http.StatusConflict, "conflict", "version not in draft state")
			return
		}
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	c.JSON(http.StatusOK, published)
}

type createVersionReq struct {
	AuthoringMode string                   `json:"authoring_mode" binding:"required,oneof=yaml ui"`
	ResourcesYAML string                   `json:"resources_yaml"`
	UISpecYAML    string                   `json:"ui_spec_yaml"`
	UIState       *template.UIModeTemplate `json:"ui_state"`
	MetadataYAML  string                   `json:"metadata_yaml"`
	Notes         string                   `json:"notes"`
}

func (h *Handlers) CreateTemplateVersion(c *gin.Context) {
	tpl, ok := h.ensureTemplateEditor(c, c.Param("name"))
	if !ok {
		return
	}

	var r createVersionReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	// mode/payload consistency — same rules as POST /v1/templates
	switch r.AuthoringMode {
	case "ui":
		if r.UIState == nil {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui requires ui_state")
			return
		}
		if r.ResourcesYAML != "" || r.UISpecYAML != "" {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui must not send resources_yaml/ui_spec_yaml")
			return
		}
		res, spec, err := template.SerializeUIMode(*r.UIState)
		if err != nil {
			writeError(c, http.StatusBadRequest, "validation-error", err.Error())
			return
		}
		r.ResourcesYAML, r.UISpecYAML = res, spec
	case "yaml":
		if r.UIState != nil {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml must not send ui_state")
			return
		}
		if r.ResourcesYAML == "" || r.UISpecYAML == "" {
			writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml requires resources_yaml + ui_spec_yaml")
			return
		}
	}

	// spec dry-run — same as CreateTemplate
	if err := template.ValidateSpec(r.ResourcesYAML, r.UISpecYAML); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	ctx := c.Request.Context()

	// "at most one draft per template" is enforced by the partial unique
	// index tv_draft_unique on (template_id) WHERE status = 'draft'. We
	// rely on it instead of a pre-check loop: avoids the list scan, closes
	// the check-then-insert race, and the insert's unique-violation is
	// translated to 409 below.

	u, okAuth := auth.UserFrom(ctx)
	if !okAuth {
		writeError(c, http.StatusUnauthorized, "unauthenticated", "user not in context")
		return
	}

	var uiStateJSON []byte
	if r.UIState != nil {
		b, _ := json.Marshal(r.UIState)
		uiStateJSON = b
	}

	var ver store.TemplateVersion
	err := h.deps.Store.WithTx(ctx, func(q *store.Queries) error {
		user, err := q.UpsertUser(ctx, store.UpsertUserParams{
			OidcSubject: u.Subject,
			Email:       store.PgText(u.Email),
			DisplayName: store.PgText(u.Name),
		})
		if err != nil {
			return err
		}
		nextVer, err := q.NextTemplateVersion(ctx, tpl.ID)
		if err != nil {
			return err
		}
		ver, err = q.InsertTemplateVersionV2(ctx, store.InsertTemplateVersionV2Params{
			TemplateID:      tpl.ID,
			Version:         nextVer,
			ResourcesYaml:   r.ResourcesYAML,
			UiSpecYaml:      r.UISpecYAML,
			MetadataYaml:    store.PgText(r.MetadataYAML),
			Status:          "draft",
			Notes:           store.PgText(r.Notes),
			CreatedByUserID: user.ID,
			AuthoringMode:   r.AuthoringMode,
			UiStateJson:     uiStateJSON,
		})
		return err
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			// Partial unique index tv_draft_unique fired: another draft
			// already exists for this template.
			writeError(c, http.StatusConflict, "conflict",
				"a draft already exists for this template; publish or delete it before creating a new version")
			return
		}
		log.Printf("CreateTemplateVersion: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to create version")
		return
	}
	c.JSON(http.StatusCreated, ver)
}

func (h *Handlers) DeprecateVersion(c *gin.Context) {
	_, ok := h.ensureTemplateEditor(c, c.Param("name"))
	if !ok {
		return
	}
	h.setVersionStatus(c, "published", "deprecated")
}

// updateVersionReq mirrors createVersionReq but every content field is a
// pointer — "not sent" means "don't touch", vs. an empty string which clears
// the column. authoring_mode is intentionally not patchable (drafts keep
// their original mode — see UpdateDraftTemplateVersion comment).
type updateVersionReq struct {
	ResourcesYAML *string                   `json:"resources_yaml"`
	UISpecYAML    *string                   `json:"ui_spec_yaml"`
	UIState       *template.UIModeTemplate  `json:"ui_state"`
	MetadataYAML  *string                   `json:"metadata_yaml"`
	Notes         *string                   `json:"notes"`
}

// UpdateTemplateVersion patches the content of a draft version in place.
// Only drafts are patchable (published/deprecated are immutable). This is the
// save target for both the UI-mode and YAML-mode editors when they're working
// on an existing draft; creating a fresh draft from a published version still
// goes through CreateTemplateVersion.
func (h *Handlers) UpdateTemplateVersion(c *gin.Context) {
	name := c.Param("name")
	if _, ok := h.ensureTemplateEditor(c, name); !ok {
		return
	}
	vnum, err := strconv.Atoi(c.Param("v"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "v must be an integer")
		return
	}
	tv, err := h.deps.Store.GetTemplateVersion(c, store.GetTemplateVersionParams{Name: name, Version: int32(vnum)})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}
	if tv.Status != "draft" {
		writeError(c, http.StatusConflict, "conflict",
			"version is "+tv.Status+"; only drafts can be updated")
		return
	}

	var r updateVersionReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	// Enforce authoring_mode / payload consistency — same rules as CreateTemplateVersion.
	// UI-mode drafts take ui_state; YAML-mode drafts take resources_yaml + ui_spec_yaml.
	// Sending the wrong payload shape is almost certainly a client bug, so reject loudly.
	params := store.UpdateDraftTemplateVersionParams{ID: tv.ID}
	switch tv.AuthoringMode {
	case "ui":
		if r.ResourcesYAML != nil || r.UISpecYAML != nil {
			writeError(c, http.StatusBadRequest, "validation-error",
				"authoring_mode=ui draft must not receive resources_yaml/ui_spec_yaml; send ui_state")
			return
		}
		if r.UIState != nil {
			res, spec, err := template.SerializeUIMode(*r.UIState)
			if err != nil {
				writeError(c, http.StatusBadRequest, "validation-error", err.Error())
				return
			}
			params.ResourcesYaml = pgtype.Text{String: res, Valid: true}
			params.UiSpecYaml = pgtype.Text{String: spec, Valid: true}
			raw, err := json.Marshal(r.UIState)
			if err != nil {
				writeError(c, http.StatusInternalServerError, "internal", "serialize ui_state: "+err.Error())
				return
			}
			params.UiStateJson = raw
		}
	case "yaml":
		if r.UIState != nil {
			writeError(c, http.StatusBadRequest, "validation-error",
				"authoring_mode=yaml draft must not receive ui_state; send resources_yaml/ui_spec_yaml")
			return
		}
		if r.ResourcesYAML != nil {
			params.ResourcesYaml = pgtype.Text{String: *r.ResourcesYAML, Valid: true}
		}
		if r.UISpecYAML != nil {
			params.UiSpecYaml = pgtype.Text{String: *r.UISpecYAML, Valid: true}
		}
	}
	if r.MetadataYAML != nil {
		params.MetadataYaml = pgtype.Text{String: *r.MetadataYAML, Valid: true}
	}
	if r.Notes != nil {
		params.Notes = pgtype.Text{String: *r.Notes, Valid: true}
	}

	// Spec dry-run so we don't persist invalid YAML. Mirrors the same gate in
	// CreateTemplateVersion; the in-place update makes the gate even more
	// important because failure can't be "undone" by just not publishing.
	finalRes := tv.ResourcesYaml
	if params.ResourcesYaml.Valid {
		finalRes = params.ResourcesYaml.String
	}
	finalSpec := tv.UiSpecYaml
	if params.UiSpecYaml.Valid {
		finalSpec = params.UiSpecYaml.String
	}
	if err := template.ValidateSpec(finalRes, finalSpec); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}

	updated, err := h.deps.Store.UpdateDraftTemplateVersion(c, params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Lost a status race — version flipped out of draft between GetTemplateVersion and UPDATE.
			writeError(c, http.StatusConflict, "conflict", "version is no longer draft")
			return
		}
		log.Printf("UpdateDraftTemplateVersion: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "update failed")
		return
	}
	c.JSON(http.StatusOK, updated)
}

// DeleteTemplateVersion removes a draft version. Published/deprecated versions
// are immutable and protected by the releases → template_versions FK's ON
// DELETE RESTRICT. We check the draft gate in the query so a stale UI that
// tries to delete a just-published version gets 409 instead of a generic 500.
func (h *Handlers) DeleteTemplateVersion(c *gin.Context) {
	name := c.Param("name")
	if _, ok := h.ensureTemplateEditor(c, name); !ok {
		return
	}
	vnum, err := strconv.Atoi(c.Param("v"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "v must be an integer")
		return
	}
	tv, err := h.deps.Store.GetTemplateVersion(c, store.GetTemplateVersionParams{Name: name, Version: int32(vnum)})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}
	if tv.Status != "draft" {
		writeError(c, http.StatusConflict, "conflict",
			"version is "+tv.Status+"; only drafts can be deleted")
		return
	}
	if _, err := h.deps.Store.DeleteDraftTemplateVersion(c, tv.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusConflict, "conflict", "version is no longer draft")
			return
		}
		log.Printf("DeleteDraftTemplateVersion: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "delete failed")
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *Handlers) UndeprecateVersion(c *gin.Context) {
	_, ok := h.ensureTemplateEditor(c, c.Param("name"))
	if !ok {
		return
	}
	h.setVersionStatus(c, "deprecated", "published")
}

func (h *Handlers) setVersionStatus(c *gin.Context, expected, newStatus string) {
	name := c.Param("name")
	vnum, err := strconv.Atoi(c.Param("v"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "v must be an integer")
		return
	}
	tv, err := h.deps.Store.GetTemplateVersion(c, store.GetTemplateVersionParams{Name: name, Version: int32(vnum)})
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template version")
		return
	}
	if tv.Status != expected {
		writeError(c, http.StatusConflict, "conflict",
			"version is "+tv.Status+", expected "+expected)
		return
	}
	updated, err := h.deps.Store.SetTemplateVersionStatus(c, store.SetTemplateVersionStatusParams{
		ID: tv.ID, Status: newStatus,
	})
	if err != nil {
		log.Printf("SetTemplateVersionStatus: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to update version status")
		return
	}
	c.JSON(http.StatusOK, updated)
}
