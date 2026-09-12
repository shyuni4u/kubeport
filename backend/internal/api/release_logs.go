package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-contrib/sse"
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
	// Everything that can be judged from the request alone is judged here,
	// before a client is built or the cluster is asked anything. A malformed
	// `?since=` used to cost an apiserver pod LIST before being turned away.
	want := c.DefaultQuery("instance", "all")
	// Pod names are capped at 253 characters by k8s; anything longer cannot
	// match and is not worth scanning the instance list for.
	if len(want) > 253 {
		writeError(c, http.StatusBadRequest, "validation-error", "instance name too long")
		return
	}

	// Where to pick up from. The browser sends `Last-Event-ID` by itself on its
	// automatic reconnect — the reconnect nobody chooses, and the one that used
	// to replay the whole container log into a pane it does not clear (#107).
	// `?since=` is the explicit form for callers with no EventSource keeping
	// track for them, and wins when both are present.
	resumeFrom, err := parseResumePoint(c.Query("since"), c.GetHeader("Last-Event-ID"))
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error",
			"since must be an RFC3339 timestamp")
		return
	}
	// Resumable only when the request names an instance, never for `all` —
	// even when `all` currently matches a single pod.
	//
	// One instant cannot stand for progress through several pods: they are
	// merged with no ordering, so the last id belongs to whichever wrote most
	// recently, and resuming all of them from it would silently skip what a
	// slower pod had not reached. Nor can it survive the set changing: a
	// single-replica release that rolls over matches one pod before and one
	// after, and the departed pod's cursor would be applied to its replacement.
	// A named instance is in the URL, means the same pod on every reconnect,
	// and answers 404 if that pod is gone. A per-pod cursor for `all` is #172.
	resumable := want != "all"
	// An explicit `?since=` on an `all` stream is refused, not ignored. The
	// caller wrote it, and answering with the whole log would look exactly like
	// a working resume while every reconnect duplicated. `Last-Event-ID` stays
	// ignored below: the browser attaches that on its own and keeps it when the
	// reader switches from one instance to `all`.
	if !resumable && c.Query("since") != "" {
		writeError(c, http.StatusBadRequest, "validation-error",
			"since requires a named instance; instance=all cannot resume")
		return
	}
	if !resumable {
		resumeFrom = time.Time{}
	}

	// Take a slot for as long as this request lives. The route's rate limiter
	// priced the open; this bounds how many a caller keeps (#169).
	//
	// Here, after every check the request alone can fail and before the first
	// cluster call: a caller already at the cap learns so without costing the
	// apiserver a LIST. The deferred release covers every way out after this
	// line — a client that cannot be built, a cluster error, no matching pod,
	// or the stream ending — so a refused request never keeps a slot.
	//
	// The refusal is its own kind, not `rate-limited`. Both are 429 and both
	// mean "not now", but they clear differently: a rate clears with time, and
	// this clears when one of the caller's streams closes. Under the shared kind
	// the web UI told a reader who had clicked once that they were requesting
	// too often, and a client that only backs off never learns that closing a
	// stream of its own is the fix. Retry-After is still sent — the RateLimited
	// response promises it on every 429 — as a backoff hint, not a prediction.
	// The X-RateLimit-* pair is left off: it is documented as requests per
	// minute, and this is a count of open streams.
	//
	// A demo account is one identity for every visitor, so its cap is one pool
	// for all of them, and a visitor holding the whole pool left the log tab
	// refusing everyone else (#200). Each sign-in to a demo account has a
	// smaller cap of its own as well, taken first, so a sign-in at its cap is
	// refused without touching the pool. Signing in again brings a new token and
	// a fresh cap: this raises what taking the pool costs, it does not end it.
	if auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
		login := loginKey(u.IDToken)
		if !h.demoStreams.tryAcquire(login) {
			refuseStream(c)
			return
		}
		defer h.demoStreams.release(login)
	}
	if !h.streams.tryAcquire(u.Subject) {
		refuseStream(c)
		return
	}
	defer h.streams.release(u.Subject)

	// Bounded by a lifetime as well as by the caller leaving (#169).
	//
	// Nothing else ends a stream the reader keeps open. The proxy in front does
	// not: Traefik's writeTimeout defaults to 0 and its idleTimeout counts only
	// idle keep-alive connections, which the 15s ping keeps this from ever
	// being. And the stream itself never looks at its caller again —
	// authorizeReleaseAccess ran once at the handshake and the cluster checked
	// the token once when the log request opened — so a tab left open went on
	// receiving pod logs after the caller's RBAC was revoked or their session
	// had expired, for as long as the tab lived.
	//
	// When the lifetime is up the handler just returns, with no `end` frame.
	// To the browser that is a dropped connection, so it reconnects — through
	// the BFF, which refreshes the token, into a handshake that authorizes
	// again. A named instance resumes from Last-Event-ID; `instance=all`
	// replays into a cleared pane, the same as after any other drop.
	//
	// It starts here, the moment the slot is taken, and covers pod discovery as
	// well as the stream: the cluster client has no timeout of its own, and an
	// apiserver that accepts the connection and never answers the listing would
	// otherwise hold the slot for as long as it stalled.
	streamCtx, cancel := context.WithTimeout(ctx, h.streamLifetime)
	defer cancel()

	cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
	if err != nil {
		internalError(c, "StreamReleaseLogs: k8s client", err)
		return
	}
	instances, err := cli.ListInstances(streamCtx, releaseRef(rel))
	if err != nil {
		clusterError(c, "StreamReleaseLogs: list instances", err)
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
	// Not reused after the stream, because of the write deadline below: with no
	// server WriteTimeout, net/http never clears a deadline set on a connection,
	// so a keep-alive request that came next would inherit a deadline that has
	// already passed and fail. Closing costs one handshake per stream, and
	// streams are long.
	c.Writer.Header().Set("Connection", "close")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	// The context only ends a handler that gets back to its select. One stuck
	// in a write does not: a reader that keeps the connection but stops reading
	// fills the socket buffers, the next write blocks in the kernel, and
	// cancelling a context does not interrupt it. So the lifetime is also a
	// deadline on writing. When it passes, the blocked write fails, net/http
	// cancels the request context, and the loop below returns with its slot.
	// A writer that cannot take a deadline — a test recorder — just goes
	// without.
	if deadline, ok := streamCtx.Deadline(); ok {
		_ = http.NewResponseController(c.Writer).SetWriteDeadline(deadline)
	}

	ch, errCh := cli.StreamLogs(streamCtx, rel.Namespace, pods, resumeFrom)
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	// end announces that the stream is over, and returns false to stop it.
	//
	// Without this the stream just stopped, and the client could not tell that
	// from a dropped connection — WHATWG gives EventSource no way to, so the
	// browser reopened three seconds later, forever. On an `instance=all`
	// stream, which has no resume point, each reopen replayed the whole
	// container log. A finished Job's pod was enough (#162).
	//
	// The reason is ours, generic, and names nothing about the cluster — same
	// rule as sseError (#108).
	end := func() bool {
		// The fan-in channels also close when streamCtx does — the pod
		// goroutines follow it. Then they closed because this handler gave up
		// (the lifetime ran out, or the reader left), not because the pods
		// stopped emitting, and saying `end` would tell the client to stop for
		// good when the right move is to reconnect. select picks at random
		// among ready cases, so without this check a rotation would sometimes
		// arrive as a false finish.
		if streamCtx.Err() != nil {
			return false
		}
		c.SSEvent("end", `{"reason":"all pods stopped emitting"}`)
		return false
	}

	c.Stream(func(w io.Writer) bool {
		select {
		case <-streamCtx.Done():
			// The reader is gone, or the lifetime is up. There is no one to
			// tell, and gin has already given up on the connection.
			//
			// A reader that vanished without closing — a laptop lid, a dead
			// network — also ends up here, but only once a write fails. Nothing
			// arrives to be read, so the server's background read never sees
			// EOF; it is net/http cancelling the request context on a failed
			// write (the next line or ping, once the kernel stops retrying)
			// that brings us here and hands the slot back. That is why this
			// context has to stay derived from the request's.
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
			// SinceTime is whole seconds, so a resume gets back everything from
			// the second the caller already had. Trim that overlap here: the
			// exact instant asked for and the line's own nanoseconds are both
			// known on this side, and doing it anywhere else would make every
			// client responsible for deduplicating to be correct.
			//
			// A line with no stamp cannot be compared, so it goes through. A
			// possible duplicate beats a line that silently disappears.
			//
			// At-or-before treats an equal stamp as already delivered, which is
			// not strictly provable: two lines written in the same nanosecond
			// would share an id and the second would be dropped unread. The
			// alternative, strictly-before, resends the boundary line on every
			// reconnect — a duplicate the reader sees at each network hiccup, to
			// insure against a tie at nanosecond resolution on per-line stamps.
			// Chosen this way deliberately. If ties turn out to happen, the fix
			// is a position beside the time in the id, not flipping this.
			if !resumeFrom.IsZero() && !line.At.IsZero() && !line.At.After(resumeFrom) {
				return true
			}
			// The container's own clock, not ours. Stamping with time.Now() here
			// dated every line to the moment we forwarded it, so opening a pod's
			// logs replayed its whole history as having happened just now — 16
			// minutes of startup all reading the same second (#131).
			//
			// Falling back to now for a line the kubelet could not stamp: the
			// alternative is a line with no time, and the pane renders one per
			// row. "Roughly now" is wrong by the age of the stream; nothing at
			// all is wrong by more, and looks like a rendering bug.
			at := line.At
			if at.IsZero() {
				at = time.Now()
			}
			body, _ := json.Marshal(map[string]any{
				"time": at.UnixMilli(),
				"pod":  line.Pod,
				"text": line.Text,
			})
			// The id is what makes the resume above possible: the browser stores
			// the last one it saw and hands it back on reconnect. Full
			// nanosecond precision, because whole seconds would make the trim
			// either drop real lines or keep duplicates.
			//
			// Only a line the kubelet actually stamped gets one. `at` may be a
			// display fallback of time.Now(), and putting that in the id would
			// tell the browser it had read up to *now* — so a drop right after
			// an unstamped line would skip whatever history was still coming.
			// A frame with no id leaves the browser's cursor where it was,
			// which is exactly right.
			//
			// And only when this stream follows one pod. See resumable().
			ev := sse.Event{Event: "log", Data: string(body)}
			if resumable && !line.At.IsZero() {
				// UTC, nine fractional digits, always. RFC3339Nano trims trailing
				// zeros and keeps the kubelet's offset, so ids varied in length
				// and zone — "…36.1Z" sorts after "…36.123Z" as a string though
				// it is earlier, and a non-browser caller picking the max id as
				// its cursor would resume past lines it never read. Fixed width
				// in one zone makes string order and time order the same thing.
				ev.Id = line.At.UTC().Format(resumeIDLayout)
			}
			c.Render(-1, ev)
			return true
		}
	})
}

// resumeIDLayout is the exact shape of a log frame's SSE id: RFC3339 in UTC
// with exactly nine fractional digits. parseResumePoint still accepts any
// RFC3339 on the way in; this only fixes what the server hands out.
const resumeIDLayout = "2006-01-02T15:04:05.000000000Z07:00"

// parseResumePoint reads the point a caller wants to pick up from.
//
// An empty result means "from the beginning", which is what a first open wants
// and what any caller gets by saying nothing.
//
// The two sources are treated differently when they do not parse, because they
// come from different places.
//
// `?since=` is something the caller wrote. A value we cannot read is their
// mistake, and answering it with the whole log would look like it worked while
// they went on sending something ignored — so it is an error.
//
// `Last-Event-ID` is something no caller ever typed. The browser attaches it
// by itself on every automatic reconnect, from whatever id it last stored, and
// nothing on the page can clear it. If that value is ever unreadable — an id
// format that has changed since the tab loaded (a per-pod cursor is planned,
// #172), a proxy or an extension that rewrote it — a 400 would repeat on every
// reconnect for as long as the tab stays open, and since a non-2xx response
// makes EventSource give up, the reader is left with a log pane that is dead
// and no way to revive it short of a reload. Starting over costs a replay; a
// lockout costs the pane. So the header degrades to "from the beginning".
func parseResumePoint(since, lastEventID string) (time.Time, error) {
	if since != "" {
		return time.Parse(time.RFC3339Nano, since)
	}
	if lastEventID == "" {
		return time.Time{}, nil
	}
	at, err := time.Parse(time.RFC3339Nano, lastEventID)
	if err != nil {
		return time.Time{}, nil
	}
	return at, nil
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
