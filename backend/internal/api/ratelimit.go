package api

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	lru "github.com/hashicorp/golang-lru/v2"

	"kubeport/internal/auth"
)

// rateLimiter is a per-caller token bucket.
//
// It exists for the SSAR proxy: one deploy-form page view fans out to several
// SelfSubjectAccessReviews against the real apiserver, the demo is open to
// anyone, and nothing else in the backend bounds how often a caller can make
// kubeport talk to the control plane (issue #73).
//
// In-process and per-replica on purpose. The kubeport deployment runs a single
// backend replica, and a shared limiter would mean Redis for a problem that
// does not need it; with N replicas the effective limit is N× the configured
// one, which still bounds the amplification. Buckets live in an LRU so an
// attacker cycling identities cannot grow the map without bound.
type rateLimiter struct {
	buckets *lru.Cache[string, *tokenBucket]
	burst   float64
	refill  float64 // tokens per second
}

type tokenBucket struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

// newRateLimiter allows `perMinute` requests per caller in steady state, with a
// burst of the same size so a single page load's fan-out is never refused.
func newRateLimiter(perMinute int, maxCallers int) *rateLimiter {
	if perMinute <= 0 {
		perMinute = 60
	}
	if maxCallers <= 0 {
		maxCallers = 4096
	}
	c, _ := lru.New[string, *tokenBucket](maxCallers)
	return &rateLimiter{
		buckets: c,
		burst:   float64(perMinute),
		refill:  float64(perMinute) / 60.0,
	}
}

// allow consumes one token for key, reporting whether there was one.
func (rl *rateLimiter) allow(key string, now time.Time) bool {
	b, ok := rl.buckets.Get(key)
	if !ok {
		b = &tokenBucket{tokens: rl.burst, last: now}
		// A concurrent Add for the same key just replaces an equivalent bucket.
		rl.buckets.Add(key, b)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tokens += now.Sub(b.last).Seconds() * rl.refill
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// rateLimit refuses a caller that is over budget with 429. Keyed by OIDC
// subject rather than IP: the whole surface is authenticated, and the identity
// is what we actually want to bound.
func rateLimit(rl *rateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		u, _ := auth.UserFrom(c.Request.Context())
		if !rl.allow(u.Subject, time.Now()) {
			writeError(c, http.StatusTooManyRequests, "rate-limited",
				"too many requests; slow down and retry")
			return
		}
		c.Next()
	}
}
