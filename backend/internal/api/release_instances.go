package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/template"
)

// sameInstanceMode refuses an update that would move a release between a
// single-instance and a multi-instance version of its template (#190), and
// reports whether the update may go on.
//
// The two modes name the release's objects differently and select its pods
// by different labels. Moving between them would apply a second set of
// objects beside the first, and change the selector of a workload that
// already exists, which the apiserver refuses because a selector cannot
// change. A template's versions share one mode now (sameModeAsTemplate), so
// this stays as the guard for versions saved before that check.
func (h *Handlers) sameInstanceMode(c *gin.Context, currentVersionID pgtype.UUID, targetUISpec string) bool {
	current, err := h.deps.Store.GetTemplateVersionByID(c.Request.Context(), currentVersionID)
	if err != nil {
		internalError(c, "UpdateRelease: current template version", err)
		return false
	}
	from, err := template.InstancesOf(current.UiSpecYaml)
	if err != nil {
		internalError(c, "UpdateRelease: current ui-spec", err)
		return false
	}
	to, err := template.InstancesOf(targetUISpec)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return false
	}
	if from != to {
		writeError(c, http.StatusBadRequest, "validation-error",
			"this release runs a "+from+"-instance version and cannot move to a "+to+"-instance one: "+
				"the two name and select the release's objects differently")
		return false
	}
	return true
}
