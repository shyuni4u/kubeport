package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"kubeport/internal/auth"
)

// StreamReleaseLogs proxies `kubectl logs -f` for every pod owned by
// the release, multiplexed over Server-Sent Events. ?instance=<name>
// filters to a single pod; default ("all") follows every pod.
func (h *Handlers) StreamReleaseLogs(c *gin.Context) {
	id, err := parseUUID(c.Param("id"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", "invalid release id")
		return
	}
	ctx := c.Request.Context()
	rel, err := h.deps.Store.GetReleaseByID(ctx, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "release")
		return
	}

	if !h.authorizeReleaseAccess(c, rel) {
		return
	}

	u, ok := auth.UserFrom(ctx)
	if !ok {
		writeError(c, http.StatusUnauthorized, "unauthenticated", "missing token")
		return
	}
	cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
	if err != nil {
		internalError(c, "StreamReleaseLogs: k8s client", err)
		return
	}
	instances, err := cli.ListInstances(ctx, rel.Namespace, rel.Name)
	if err != nil {
		clusterError(c, "StreamReleaseLogs: list instances", err)
		return
	}

	want := c.DefaultQuery("instance", "all")
	// k8s pod name limit is 253; reject anything longer than that to
	// avoid wasted work scanning the instance list.
	if len(want) > 253 {
		writeError(c, http.StatusBadRequest, "validation-error", "instance name too long")
		return
	}
	var pods []string
	for _, ins := range instances {
		if want == "all" || want == ins.Name {
			pods = append(pods, ins.Name)
		}
	}
	if len(pods) == 0 {
		writeError(c, http.StatusNotFound, "no-pods", "no matching instance")
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	ch, errCh := cli.StreamLogs(streamCtx, rel.Namespace, pods)
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	// end announces that the stream is over, and returns false to stop it.
	//
	// Without this the stream just stopped, and the client could not tell that
	// from a dropped connection — WHATWG gives EventSource no way to, so the
	// browser reopened three seconds later and, since we open with no
	// SinceTime, replayed the whole container log. A browser-initiated
	// reconnect does not clear the pane either, so the same lines accumulated
	// until they filled it. A finished Job's pod was enough (#162).
	//
	// The reason is ours, generic, and names nothing about the cluster — same
	// rule as sseError (#108).
	end := func() bool {
		c.SSEvent("end", `{"reason":"all pods stopped emitting"}`)
		return false
	}

	c.Stream(func(w io.Writer) bool {
		select {
		case <-streamCtx.Done():
			// The reader is gone. There is no one to tell, and gin has already
			// given up on the connection.
			return false
		case <-ping.C:
			c.SSEvent("ping", time.Now().Unix())
			return true
		case err, ok := <-errCh:
			if !ok {
				// A closed channel is always ready, so leaving it in the
				// select would spin. Drop it and keep serving the other one.
				errCh = nil
				if ch != nil {
					return true
				}
				return end()
			}
			if err != nil {
				// client-go's text names the apiserver's address, the
				// namespace and the pod, and this frame is rendered verbatim
				// in the log pane — for demo visitors too (issue #108). The
				// reason goes to the log; the caller gets the request id.
				//
				// %q on the namespace: it is user input and, unlike Name, it
				// carries no format binding, so a newline in it would forge a
				// log line — the rule #72 set in accesslog.go.
				logWithheld(c,
					fmt.Sprintf("StreamReleaseLogs: release=%q namespace=%q stream",
						rel.Name, rel.Namespace),
					err)
				status, kind := streamErrorKind(err)
				sseError(c, status, kind, "the log stream from the cluster failed")
			}
			return true
		case line, ok := <-ch:
			if !ok {
				// StreamPodLogs buffers a pod's error and only then closes both
				// channels, so at this point an error may already be waiting.
				// Ending here would race it: select picks uniformly among ready
				// cases, and the error frame was being dropped about half the
				// time. Give up this channel and let errCh drain first.
				ch = nil
				if errCh != nil {
					return true
				}
				return end()
			}
			body, _ := json.Marshal(map[string]any{
				"time": time.Now().UnixMilli(),
				"pod":  line.Pod,
				"text": line.Text,
			})
			c.SSEvent("log", string(body))
			return true
		}
	})
}

// clusterError answers a cluster call that failed *before* the stream opened,
// using the same vocabulary the in-stream frame uses.
//
// upstreamError folds all of these into `k8s-error`. For a one-shot request
// that is fine — the caller retries or gives up. For this endpoint it is not:
// the same apiserver 401 is called `cluster-auth-denied` once the stream is up
// (streamErrorKind, since #82) and `k8s-error` one instruction earlier, and the
// client gates its Reconnect button on the kind (#134). A permanent refusal
// arriving as the retryable kind is an invitation to retry something that can
// never clear. The handshake should not change what a failure is called.
//
// The detail is ours, not client-go's, for the reason spelled out at sseError:
// its text names the apiserver's address, the namespace and the pod (#108).
func clusterError(c *gin.Context, op string, err error) {
	logWithheld(c, op, err)
	switch {
	case apierrors.IsUnauthorized(err):
		writeError(c, http.StatusBadGateway, "cluster-auth-denied", op+" failed")
	case apierrors.IsForbidden(err):
		writeError(c, http.StatusForbidden, "rbac-denied", op+" failed")
	default:
		writeError(c, http.StatusBadGateway, "k8s-error", op+" failed")
	}
}

// streamErrorKind picks the kind for an in-stream failure.
//
// Folding every failure into one kind made the frame's vocabulary a set of
// size one: the title never varied, so there was nothing to branch on, and the
// only thing that changed per frame was the request id — which an automated
// client cannot look up, since it cannot read the server's log. The
// distinctions below are the ones that change what a client should do next,
// and they come from the predicate ordinary responses already use.
func streamErrorKind(err error) (int, string) {
	switch {
	case apierrors.IsUnauthorized(err):
		// The cluster refused the forwarded token, not kubeport's session —
		// the distinction #83 drew for the OpenAPI proxy. Re-authenticating
		// against kubeport will not help.
		return http.StatusBadGateway, "cluster-auth-denied"
	case apierrors.IsForbidden(err):
		// The caller may read the release but not its pods' logs. Permanent
		// until someone changes the cluster's RBAC.
		return http.StatusForbidden, "rbac-denied"
	default:
		// Transport failures and everything else: worth retrying.
		return http.StatusBadGateway, "k8s-error"
	}
}
