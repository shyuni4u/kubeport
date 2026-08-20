package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kubeport/internal/template"
)

type previewReq struct {
	UIState template.UIModeTemplate `json:"ui_state" binding:"required"`
}

func (h *Handlers) PreviewTemplate(c *gin.Context) {
	var r previewReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	resources, uispec, err := template.SerializeUIMode(r.UIState)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"resources_yaml": resources,
		"ui_spec_yaml":   uispec,
	})
}
