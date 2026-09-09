package api

import (
	"log"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kubeport/internal/auth"
)

// requestIDKey is where the per-request id lives in the gin context, so both
// the access log line and the Problem body can carry the same value.
const requestIDKey = "kbp_request_id"

// requestIDHeader lets an ingress or a client correlate its own logs with ours.
const requestIDHeader = "X-Request-Id"

// reqIDPattern is what an inbound id has to look like to be adopted.
//
// A length cap is not enough: header values may contain spaces and `=`, so a
// 64-character id like `z status=200 user=admin@example.com` forges fields
// inside the log line, and a parser or grep reading left to right sees a
// refused request as a successful one under someone else's name. The demo
// password is on the landing page, so that is reachable by anyone.
var reqIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// requestID assigns each request an id, honouring an inbound X-Request-Id so a
// trace survives the BFF hop, and echoes it on the response.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(requestIDHeader)
		if !reqIDPattern.MatchString(id) {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header(requestIDHeader, id)
		c.Next()
	}
}

func requestIDFrom(c *gin.Context) string {
	if v, ok := c.Get(requestIDKey); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// accessLog records who asked for what and how it ended.
//
// The router had gin.Recovery() and nothing else, so a refused deploy — the
// exact event you want to answer "did anyone try to reach outside the demo?"
// — left no trace anywhere: writeError only writes the response, and
// releases.go logged only when the *rollback* failed. Issue #72.
//
// Deliberately not logged: the bearer token, the request body (values_json
// carries user-supplied config, sometimes secrets), and query strings. Identity
// is the OIDC subject plus email, which is what an audit question is about.
func accessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Liveness and readiness hit /healthz every 10 and 20 seconds — roughly
		// 13k lines a day, which would bury the handful of lines this exists to
		// make findable.
		if c.Request.URL.Path == "/healthz" {
			c.Next()
			return
		}

		start := time.Now()
		// Deferred so a panicking handler is still recorded. Without it the
		// stack unwinds past this point straight to gin.Recovery(), and the
		// requests most worth having a record of — the ones whose input broke
		// something — are the only ones with no line at all.
		defer func() {
			u, _ := auth.UserFrom(c.Request.Context())
			subject := u.Subject
			if subject == "" {
				subject = "-"
			}
			email := u.Email
			if email == "" {
				email = "-"
			}
			// FullPath is the route pattern ("/v1/templates/:name"), which keeps
			// user-supplied path values out of the log. It is empty when nothing
			// matched, and then the raw path is the interesting part — quoted,
			// because an unmatched path is attacker-controlled and a newline in it
			// would forge a log line.
			path := c.FullPath()
			if path == "" {
				path = c.Request.URL.EscapedPath()
			}
			// Quoted: the path can be unmatched and attacker-controlled, and
			// the identity fields come from an IdP we do not control.
			log.Printf("access id=%s method=%s path=%q status=%d dur=%s user=%q subject=%q",
				requestIDFrom(c), c.Request.Method, path, c.Writer.Status(),
				time.Since(start).Round(time.Millisecond), email, subject)
		}()

		c.Next()
	}
}
