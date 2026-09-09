package api

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"kubeport/internal/auth"
)

type TokenVerifier interface {
	Verify(ctx context.Context, raw string) (auth.Claims, error)
}

func requireAuth(v TokenVerifier) gin.HandlerFunc {
	// Parse KBP_DEV_ADMIN_EMAILS once at router construction so we pay the
	// env lookup + split cost once instead of per request, and so hot-path
	// membership is an O(1) map lookup. The env is read at startup; changes
	// require a restart. Never set in production — see cmd/server/main.go
	// for the startup warning.
	devAdminEmails := parseDevAdminEmails(os.Getenv("KBP_DEV_ADMIN_EMAILS"))
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeError(c, http.StatusUnauthorized, "unauthenticated", "missing bearer token")
			return
		}
		raw := strings.TrimPrefix(h, "Bearer ")
		claims, err := v.Verify(c.Request.Context(), raw)
		if err != nil {
			// Two things used to ride out on this, both unauthenticated:
			//
			// The issuer's address. A discovery failure is wrapped as
			// `issuer %s: Get "https://…/.well-known/openid-configuration":
			// dial tcp <ClusterIP>:<port>: connect: connection refused`, so
			// while Dex was down anyone could read an in-cluster address —
			// the leak #49 and #108 closed on 500s and on the log stream,
			// still open on the one response you get without signing in.
			//
			// And the caller's own string. `unknown issuer %q` quotes an
			// `iss` that auth.peekIssuer reads out of the JWT payload
			// *without verifying the signature*, so anything you put in an
			// unsigned token came back in the body, length-unbounded. That is
			// the reflection this PR's own fallback test forbids.
			logWithheld(c, "requireAuth: verify", err)
			writeError(c, http.StatusUnauthorized, "unauthenticated", "token verification failed")
			return
		}
		if claims.Email != "" {
			if _, ok := devAdminEmails[strings.ToLower(claims.Email)]; ok {
				claims.Groups = append(claims.Groups, "kubeport-admin")
			}
		}
		ctx := auth.WithUser(c.Request.Context(), auth.RequestUser{Claims: claims, IDToken: raw})
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

func parseDevAdminEmails(raw string) map[string]struct{} {
	if raw == "" {
		return nil
	}
	m := make(map[string]struct{})
	for _, e := range strings.Split(raw, ",") {
		if e = strings.TrimSpace(strings.ToLower(e)); e != "" {
			m[e] = struct{}{}
		}
	}
	return m
}

func requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		u, _ := auth.UserFrom(c.Request.Context())
		for _, g := range u.Groups {
			if g == "kubeport-admin" {
				c.Next()
				return
			}
		}
		writeError(c, http.StatusForbidden, "rbac-denied", "admin group required")
	}
}

// denyDemo returns 403 for demo-domain accounts. Mounted only on routes that
// would let a demo visitor change shared infrastructure (cluster registration,
// team management, force delete). Everything else stays governed by k8s RBAC.
func denyDemo(domain string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if domain == "" {
			c.Next()
			return
		}
		u, _ := auth.UserFrom(c.Request.Context())
		if auth.IsDemoEmail(u.Email, domain) {
			writeError(c, http.StatusForbidden, "demo-restricted", "demo accounts cannot perform this action")
			return
		}
		c.Next()
	}
}
