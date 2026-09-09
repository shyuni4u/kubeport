package api

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

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

// internalError answers 500 without the error text and logs the text instead.
//
// A pgx connect failure spells out `host=... user=... database=...`, and a k8s
// transport failure carries the apiserver's internal address; either one told
// any authenticated caller — a public demo visitor included — about
// infrastructure they cannot otherwise see. The operation name still goes to
// the client so a bug report says which call failed (issue #49).
//
// 4xx deliberately keeps its detail: a validation message is the whole point of
// the response, and the k8s authorizer's "Forbidden: ..." text is what tells a
// user why their deploy was refused.
func internalError(c *gin.Context, op string, err error) {
	log.Printf("%s: %v", op, err)
	writeError(c, http.StatusInternalServerError, "internal", op+" failed")
}
