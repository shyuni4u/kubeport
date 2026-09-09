package api

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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
		// Ties the response the user is looking at to the access-log line and
		// any server-side detail we withheld from them (#72). The field was
		// declared but never populated.
		RequestID: requestIDFrom(c),
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

// upstreamError answers 502 for a failed call to a cluster, keeping the
// apiserver's own words only when they are addressed to the user.
//
// The k8s authorizer's `... is forbidden: User "x" cannot create deployments`
// is the whole reason a deploy failed and belongs on screen. A transport
// failure is not: client-go wraps it as *url.Error, so the text is
// `Post "https://10.0.x.x:6443/apis/...": dial tcp ...` — the cluster's
// address, which ListClusters deliberately stopped returning (#52). Fixing
// only the 500s (#49) would have left that leak one status code over.
func upstreamError(c *gin.Context, op string, err error) {
	log.Printf("%s: %v", op, err)
	if fromCluster(err) {
		writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
		return
	}
	writeError(c, http.StatusBadGateway, "k8s-error", op+" failed")
}

// fromCluster reports whether the apiserver answered with a verdict, as
// opposed to the call never getting there.
func fromCluster(err error) bool {
	return apierrors.IsForbidden(err) ||
		apierrors.IsInvalid(err) ||
		apierrors.IsNotFound(err) ||
		apierrors.IsAlreadyExists(err) ||
		apierrors.IsConflict(err) ||
		apierrors.IsUnauthorized(err)
}
