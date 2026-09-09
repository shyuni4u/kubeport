package api

import (
	"fmt"
	"log"
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

// requestID assigns each request an id, honouring an inbound X-Request-Id so a
// trace survives the BFF hop, and echoes it on the response.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(requestIDHeader)
		// Don't trust an arbitrary-length client value into every log line.
		if id == "" || len(id) > 64 {
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
		start := time.Now()
		c.Next()

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
			path = fmt.Sprintf("%q", c.Request.URL.EscapedPath())
		}
		log.Printf("access id=%s method=%s path=%s status=%d dur=%s user=%s subject=%s",
			requestIDFrom(c), c.Request.Method, path, c.Writer.Status(),
			time.Since(start).Round(time.Millisecond), email, subject)
	}
}
