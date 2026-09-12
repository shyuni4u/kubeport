package api

import (
	"errors"
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
// every write handler reads the whole body into memory via bindJSON.
// Sized for a template's resources.yaml with room to spare.
const maxRequestBody = 4 << 20 // 4 MiB

// payloadTooLargeDetail names the cap in the words the spec uses. Keep it in
// step with maxRequestBody.
const payloadTooLargeDetail = "request body exceeds 4 MiB"

// limitBodySize enforces maxRequestBody in two places, because a body's size
// is known up front only sometimes.
//
// A declared Content-Length over the cap is refused here, before routing, auth
// or any handler, on every method — a GET that announces a 5 MiB body gets 413
// too, even though no GET handler reads one. The request asked to send more
// than any request may carry; answering it on its merits would mean holding
// the connection for bytes kubeport has already decided not to read. It tells
// an unauthenticated caller nothing: the cap is the same on every path and is
// published in the spec. The cost is attribution: auth has not run, so the
// access log records such a 413 with user="-" even when the request carried a
// valid token. Nothing ran, so nothing is hidden — join it to the BFF's line by
// request_id.
//
// A body of unknown length (chunked) cannot be judged until it is read, so it
// is wrapped in a MaxBytesReader and the overflow surfaces at the read, where
// bindJSON turns it into the same 413.
func limitBodySize(max int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > max {
			writePayloadTooLarge(c)
			return
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, max)
		}
		c.Next()
	}
}

// bindJSON is the one way a handler reads a request body. On failure it has
// already answered and the handler must return.
//
// An oversized body is `413 payload-too-large`, not the `400 validation-error`
// every other bind failure is (#128). The two call for opposite client
// responses — fix the body and resend, versus split it or give up, because
// resending it unchanged can never succeed — and before this the only
// difference between them was Go's own English in `detail`, which the contract
// says may change.
func bindJSON(c *gin.Context, dst any) bool {
	err := c.ShouldBindJSON(dst)
	if err == nil {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writePayloadTooLarge(c)
		return false
	}
	writeError(c, http.StatusBadRequest, "validation-error", err.Error())
	return false
}

func writePayloadTooLarge(c *gin.Context) {
	writeError(c, http.StatusRequestEntityTooLarge, "payload-too-large", payloadTooLargeDetail)
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
