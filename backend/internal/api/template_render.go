package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"kubeport/internal/store"
	"kubeport/internal/template"
)

// previewRenderReq is the body for POST /v1/templates/:name/render.
// Values is treated as an opaque JSON object forwarded to template.Render;
// the template's ui-spec decides which keys are required.
type previewRenderReq struct {
	Values json.RawMessage `json:"values"`
	// ReleaseID names the release an update form is previewing (#196). Its
	// Secret values read back redacted, and the form sends the placeholder for
	// one left unchanged; with the release named, the preview renders the
	// stored value in its place — and redacts the rendered output, so the
	// preview never shows what the read hid.
	ReleaseID string `json:"release_id,omitempty"`
}

// PreviewRender renders a template with the supplied values for UI preview.
// Does NOT apply to k8s and does NOT persist anything.
//
// Version selection:
//   - ?version=N           → render that specific version. Drafts are visible
//     to the template's editors only (issue #12); published and deprecated
//     versions to any authenticated user.
//   - no ?version          → render the template's current published version.
//     If the template has no current_version_id set (never published), → 404.
//
// Error mapping:
//   - malformed JSON body                     → 400 validation-error
//   - non-integer ?version                    → 400 validation-error
//   - unknown template                        → 404 not-found
//   - unknown version / no published version  → 404 not-found
//   - template.Render error (missing required
//     field, pattern mismatch, min/max, etc.) → 400 validation-error
//     (surfaced verbatim so the UI can highlight the offending field)
func (h *Handlers) PreviewRender(c *gin.Context) {
	var r previewRenderReq
	if !bindJSON(c, &r) {
		return
	}
	if len(r.Values) == 0 {
		// template.Render requires a JSON object; normalize missing body.
		r.Values = json.RawMessage("{}")
	}

	name := c.Param("name")
	tv, ok := h.resolveTemplateVersion(c, name, c.Query("version"))
	if !ok {
		return
	}

	forRelease := r.ReleaseID != ""
	if forRelease {
		id, err := parseUUID(r.ReleaseID)
		if err != nil {
			writeError(c, http.StatusBadRequest, "validation-error", "invalid release_id")
			return
		}
		rel, err := h.deps.Store.GetReleaseByID(c.Request.Context(), id)
		if err != nil {
			writeError(c, http.StatusNotFound, "not-found", "release")
			return
		}
		// The same gate as reading the release: its stored values are what
		// this puts back.
		if !h.authorizeReleaseAccess(c, rel) {
			return
		}
		if rel.TemplateName != name {
			writeError(c, http.StatusBadRequest, "validation-error", "release_id is not a release of this template")
			return
		}
		// Only for the release's own version, whose rules the stored value
		// already passed, so the response cannot depend on it. Checked against
		// another version — a draft whose pattern the caller wrote — a 200 or
		// 400 would say whether the stored value matches (security review).
		// There the placeholder stays as sent and is validated as it is.
		if tv.ID == rel.TemplateVersionID {
			r.Values, _ = restoreRedactedSecrets(r.Values, rel.ValuesJson)
		}
	}

	rendered, err := template.Render(tv.ResourcesYaml, tv.UiSpecYaml, r.Values, template.Labels{
		TemplateName:    name,
		TemplateVersion: int(tv.Version),
		ReleaseName:     "preview",
		// ReleaseID / AppliedBy left empty: preview is not a real release.
	})
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	out := string(rendered)
	if forRelease {
		out = redactRenderedSecrets(out)
	}

	c.JSON(http.StatusOK, gin.H{
		"template":      name,
		"version":       tv.Version,
		"rendered_yaml": out,
	})
}

// resolveTemplateVersion returns the requested version row.
// If versionQuery == "", it returns the template's current published version.
// On any failure it writes the response and returns ok=false.
//
// Error mapping (writes response, returns false):
//   - versionQuery non-empty but not an integer → 400 validation-error
//   - versionQuery refers to unknown version     → 404 not-found
//   - default path, template missing             → 404 not-found
//   - default path, no current_version_id        → 404 not-found
//   - default path, DB failure                   → 500 internal (logged)
//
// Tasks 2 and 3 of Plan 3 (PUT /v1/releases/:id, RBAC checks) may also call
// this helper. Keeping it in template_render.go for now; promote to a shared
// location if a second caller materializes.
func (h *Handlers) resolveTemplateVersion(c *gin.Context, name, versionQuery string) (store.TemplateVersion, bool) {
	ctx := c.Request.Context()

	// Explicit ?version=N: integer parse failure (bad query param) is distinct
	// from "version not found" — the former is the caller's bug.
	if versionQuery != "" {
		v64, err := strconv.ParseInt(versionQuery, 10, 32)
		if err != nil {
			writeError(c, http.StatusBadRequest, "validation-error", "version must be integer")
			return store.TemplateVersion{}, false
		}
		tv, err := h.deps.Store.GetTemplateVersion(ctx, store.GetTemplateVersionParams{
			Name:    name,
			Version: int32(v64),
		})
		if err != nil {
			// ErrNoRows → legitimate 404. Real DB errors also surface as 404
			// here to match h.GetTemplate's behavior (see templates.go). A DB
			// outage will look like "template not found" — improving the
			// overall pattern is outside Task 1's scope.
			writeError(c, http.StatusNotFound, "not-found", "template version")
			return store.TemplateVersion{}, false
		}
		// Rendering returns the template's substance, so it follows the same
		// demo line as reading it (#238).
		if h.versionHiddenByDemoScope(c, name, "template version") {
			return store.TemplateVersion{}, false
		}
		// ?version=N can address a draft, so it needs the same read gate as
		// GET /v1/templates/:name/versions/:v — rendering returns the
		// substance of the draft's resources.yaml (issue #12).
		if !h.ensureCanReadVersion(c, name, tv.Status) {
			return store.TemplateVersion{}, false
		}
		return tv, true
	}

	// Default: current published version via template.current_version_id.
	tpl, err := h.deps.Store.GetTemplateByName(ctx, name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusNotFound, "not-found", "template")
			return store.TemplateVersion{}, false
		}
		log.Printf("resolveTemplateVersion: GetTemplateByName(%q): %v", name, err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to load template")
		return store.TemplateVersion{}, false
	}
	if h.templateHiddenByDemoScope(c, tpl.OwnerUserID, "template") {
		return store.TemplateVersion{}, false
	}
	if !tpl.CurrentVersionID.Valid {
		// Never published: only those who may read its drafts learn that it
		// exists. Everyone else gets the answer for a name that matches
		// nothing, as the catalog and GET /v1/templates/:name already give
		// them (#238).
		canRead, err := h.canReadTemplate(ctx, nil, ownershipOf(tpl))
		if err != nil {
			internalError(c, "resolveTemplateVersion", err)
			return store.TemplateVersion{}, false
		}
		if !canRead {
			writeError(c, http.StatusNotFound, "not-found", "template")
			return store.TemplateVersion{}, false
		}
		writeError(c, http.StatusNotFound, "not-found", "template has no published version; pass ?version=N")
		return store.TemplateVersion{}, false
	}
	tv, err := h.deps.Store.GetTemplateVersionByID(ctx, tpl.CurrentVersionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Defensive: current_version_id points at a row that no longer
			// exists (data inconsistency) — treat as no published version.
			writeError(c, http.StatusNotFound, "not-found", "template has no published version; pass ?version=N")
			return store.TemplateVersion{}, false
		}
		log.Printf("resolveTemplateVersion: GetTemplateVersionByID(%s): %v", tpl.CurrentVersionID.String(), err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to load template version")
		return store.TemplateVersion{}, false
	}
	return tv, true
}
