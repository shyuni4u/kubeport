package api

import "github.com/gin-gonic/gin"

type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

func writeError(c *gin.Context, status int, kind, detail string) {
	c.AbortWithStatusJSON(status, Problem{
		Type:   "https://kubeport.io/errors/" + kind,
		Title:  kind,
		Status: status,
		Detail: detail,
	})
}
