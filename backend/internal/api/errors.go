package api

import (
	"encoding/json"
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

// sseError writes a Problem as a named `error` event on an already-upgraded
// stream, so a failure before and after the SSE handshake reach the client in
// the same shape (issue #82). The old frame was a bare {"error": "..."} with
// no kind, which forced a second parser on the client and gave it nothing to
// branch on.
//
// detail is ours, never the underlying error: the frame is rendered verbatim
// in the log pane, and client-go's text names the apiserver's address, the
// namespace, and the pod (issue #108). The caller logs the real reason and the
// request id ties the two together.
func sseError(c *gin.Context, status int, kind, detail string) {
	body, err := json.Marshal(Problem{
		Type:      "https://kubeport.io/errors/" + kind,
		Title:     kind,
		Status:    status,
		Detail:    detail,
		RequestID: requestIDFrom(c),
	})
	if err != nil {
		// Problem is a struct of strings and an int; this cannot fail. Bail
		// rather than emit a half-written frame if it somehow does.
		log.Printf("sseError: marshal problem: %v", err)
		return
	}
	c.SSEvent("error", string(body))
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
	logWithheld(c, op, err)
	writeError(c, http.StatusInternalServerError, "internal", op+" failed")
}

// logWithheld writes the reason we did not put in the response, keyed by the
// id the caller was given.
//
// Without the id this is a promise the logs cannot keep. The access log does
// carry it, but it is written when the request *ends* and it records
// `c.FullPath()` — the route pattern, not the path — so `/v1/releases/:id/logs`
// says nothing about which release. For an ordinary request the two lines land
// next to each other and a human can bridge the gap; for a log stream that
// stays open for minutes while others start and finish, there is nothing to
// join on. Put the id on the line that has the reason.
func logWithheld(c *gin.Context, op string, err error) {
	log.Printf("id=%s %s: %v", requestIDFrom(c), op, err)
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
	logWithheld(c, op, err)
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
