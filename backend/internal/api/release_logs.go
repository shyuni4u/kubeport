package api

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

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
		upstreamError(c, "StreamReleaseLogs: list instances", err)
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

	c.Stream(func(w io.Writer) bool {
		select {
		case <-streamCtx.Done():
			return false
		case <-ping.C:
			c.SSEvent("ping", time.Now().Unix())
			return true
		case err, ok := <-errCh:
			if !ok {
				// A closed channel is always ready, so leaving it in the
				// select would spin. Drop it and keep serving the other one.
				errCh = nil
				return ch != nil
			}
			if err != nil {
				// client-go's text names the apiserver's address, the
				// namespace and the pod, and this frame is rendered verbatim
				// in the log pane — for demo visitors too (issue #108). The
				// reason goes to the log; the caller gets the request id.
				log.Printf("StreamReleaseLogs: release=%s namespace=%s stream: %v",
					rel.Name, rel.Namespace, err)
				sseError(c, http.StatusBadGateway, "k8s-error",
					"the log stream from the cluster failed")
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
				return errCh != nil
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
