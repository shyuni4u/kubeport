package api

import (
	"math"
	"net/http"
	"strconv"
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

// allow consumes one token for key. When there is none it reports how long
// until there is, so the caller can be told instead of made to guess.
func (rl *rateLimiter) allow(key string, now time.Time) (bool, time.Duration) {
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
		wait := time.Duration((1 - b.tokens) / rl.refill * float64(time.Second))
		return false, wait
	}
	b.tokens--
	return true, 0
}

// maxRequestBody caps what any handler will read. The rate limiter bounds how
// often a caller can ask, not how large the ask is: 60 requests carrying
// hundreds of megabytes each would still exhaust a single-node backend, and
// every write handler reads the whole body into memory via ShouldBindJSON.
// Sized for a template's resources.yaml with room to spare.
const maxRequestBody = 4 << 20 // 4 MiB

func limitBodySize(max int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max)
		}
		c.Next()
	}
}

// rateLimit refuses a caller that is over budget with 429. Keyed by OIDC
// subject rather than IP: the whole surface is authenticated, and the identity
// is what we actually want to bound.
//
// Note the demo's shared identities: Dex issues two static accounts, so every
// concurrent demo visitor draws on one bucket. Keying on the client IP as well
// would separate them, but gin reads X-Forwarded-For, which a caller can set —
// trading a shared budget for an evadable one. Left as-is deliberately; if the
// demo starts hitting the limit, raise it for the demo domain rather than
// trusting a header.
func rateLimit(rl *rateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if overBudget(c, rl) {
			return
		}
		c.Next()
	}
}

// overBudget spends one of the caller's tokens from rl, or writes the 429 and
// reports true when there is none. rateLimit uses it as route middleware; a
// handler calls it directly when a request should only pay once it is past
// the checks that refuse it for free (Handlers.releaseWrite, #232).
func overBudget(c *gin.Context, rl *rateLimiter) bool {
	if rl == nil {
		return false
	}
	u, _ := auth.UserFrom(c.Request.Context())
	ok, wait := rl.allow(u.Subject, time.Now())
	if ok {
		return false
	}
	// Retry-After is RFC 9110, so most HTTP clients and agent SDKs already
	// honour it. Without it a program either retries at once — defeating the
	// limit — or sleeps an arbitrary constant.
	secs := int(math.Ceil(wait.Seconds()))
	if secs < 1 {
		secs = 1
	}
	c.Header("Retry-After", strconv.Itoa(secs))
	c.Header("X-RateLimit-Limit", strconv.Itoa(int(rl.burst)))
	c.Header("X-RateLimit-Remaining", "0")
	writeError(c, http.StatusTooManyRequests, "rate-limited",
		"too many requests; retry after "+strconv.Itoa(secs)+"s")
	return true
}
