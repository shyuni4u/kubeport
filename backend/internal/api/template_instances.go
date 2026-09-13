package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/template"
)

// sameModeAsTemplate refuses a version whose `instances` mode differs from the
// template's released versions (#190), and reports whether the write may go
// on. except is the version being written, left out of the comparison; drafts
// are left out too, since they can still change.
//
// A mode is fixed per template rather than only per release (security
// review). With one template holding a single and a multiple version, a
// single release and a multiple release can sit in one namespace: the single
// one's Service keeps the template's own selector — app: web — and routes to
// the multiple release's pods, which carry the same template labels.
// Refusing the update across modes alone did not stop that; it only pointed
// at deploying the other version as a new release.
func (h *Handlers) sameModeAsTemplate(c *gin.Context, templateName, uiSpecYAML string, except pgtype.UUID) bool {
	mode, err := template.InstancesOf(uiSpecYAML)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return false
	}
	versions, err := h.deps.Store.ListTemplateVersions(c.Request.Context(), templateName)
	if err != nil {
		internalError(c, "template versions for instance mode", err)
		return false
	}
	for _, v := range versions {
		if v.ID == except || v.Status == "draft" {
			continue
		}
		other, err := template.InstancesOf(v.UiSpecYaml)
		if err != nil {
			internalError(c, "stored ui-spec for instance mode", err)
			return false
		}
		if other != mode {
			writeError(c, http.StatusBadRequest, "validation-error",
				"this template's released versions are "+other+"-instance, so a version cannot be "+mode+"-instance: "+
					"the two modes name and select a release's objects differently; make a new template for the other mode")
			return false
		}
	}
	return true
}
