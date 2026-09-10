package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"kubeport/internal/template"
)

// ProblemTemplateDefect is the template_defect extension member.
type ProblemTemplateDefect struct {
	// Path is the ui-spec path of the field at fault.
	Path string `json:"path"`
	// Type is the field type kubeport does not know.
	Type string `json:"type"`
}

// renderProblem answers a failed template.Render. Every render error is a 400
// validation-error, but one kind is not the caller's to fix: a version saved
// before ValidateSpec checked types can name a type kubeport does not know,
// and no input deploys it (#136). That one carries template_defect, so the
// deploy form can send the user to an admin rather than back to their input.
func renderProblem(c *gin.Context, err error) {
	var ute *template.UnsupportedTypeError
	if errors.As(err, &ute) {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error(), func(p *Problem) {
			p.TemplateDefect = &ProblemTemplateDefect{Path: ute.Path, Type: string(ute.Type)}
		})
		return
	}
	writeError(c, http.StatusBadRequest, "validation-error", err.Error())
}
