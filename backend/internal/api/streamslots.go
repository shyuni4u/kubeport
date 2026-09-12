package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
)

// defaultLogStreamLifetime is how long one log stream may stay open before the
// server ends it and the client reconnects.
//
// An hour is a re-check cadence, not a token lifetime. The stream never looks
// at its caller again after the handshake, so this is the longest a caller
// whose RBAC was revoked, or whose kubeport session ended, goes on receiving
// logs: until the next reconnect, which goes back through the BFF, a fresh
// authorizeReleaseAccess and a fresh log request the cluster checks. It is
// deliberately not derived from the IdP — the demo's Dex runs with its default
// 24h id_token, Google issues 1h ones — so the bound holds whichever issuer is
// in front. Shorter would reconnect, and on `instance=all` clear the pane, more
// often than it buys.
const defaultLogStreamLifetime = time.Hour

// logStreamLifetime turns a configured lifetime into the one to use. Zero
// means unset, so most tests and a bare config get the default.
func logStreamLifetime(d time.Duration) time.Duration {
	if d <= 0 {
		return defaultLogStreamLifetime
	}
	return d
}

// defaultLogStreamsPerCaller is how many log streams one caller may hold open
// at once when nothing else is configured.
//
// Sixteen leaves ordinary use alone — a reader with the overview in one tab and
// logs for a couple of pods in others is nowhere near it — while still putting
// a ceiling on what one identity can keep alive. The demo is what sets the
// ceiling's scale: its two Dex accounts are shared by every visitor, so for the
// demo this is close to a global cap on concurrent log viewers per role.
const defaultLogStreamsPerCaller = 16

// demoLogStreamsPerLogin is how many log streams one sign-in to a demo account
// may hold open (#200). The per-caller cap above is, for a demo account, one
// pool for every visitor, and a single visitor holding all of it — a script
// opening sixteen streams, say — left the log tab refusing everyone else.
// Eight is half the pool, and more than one reader's tabs need: a stream whose
// connection dropped without closing holds its slot until a write to it fails,
// which can take minutes, while the browser reconnects under the same sign-in —
// so a reader on a flaky connection needs room above their open tabs, or they
// lock themselves out (security review).
const demoLogStreamsPerLogin = 8

// loginKey names one sign-in by the id token it presented. A digest, not the
// token: the token is a credential, and the key sits in a map for as long as
// the stream lives.
//
// Digested as the verifier reads it, not as the text sent: one signed token has
// many spellings that all verify, and hashing the text gave each spelling its
// own cap — one sign-in the whole pool again. The verifier (go-jose) strips
// whitespace anywhere in the token, decodes each segment with a lenient
// base64url decoder that ignores a segment's spare trailing bits, and rebuilds
// the signed input from the decoded header and payload (codex and security
// review). So the key is taken over the three segments decoded, after the same
// whitespace is removed, each prefixed with its length.
//
// A token that does not split and decode that way could not have verified,
// and never reaches a handler; it is hashed as sent.
func loginKey(idToken string) string {
	token := strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, idToken)
	h := sha256.New()
	if segments, ok := decodeJWS(token); ok {
		for _, seg := range segments {
			fmt.Fprintf(h, "%d:", len(seg))
			h.Write(seg)
		}
	} else {
		h.Write([]byte(token))
	}
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// decodeJWS decodes the three segments of a compact JWS.
func decodeJWS(token string) ([][]byte, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	out := make([][]byte, 0, 3)
	for _, p := range parts {
		b, err := base64.RawURLEncoding.DecodeString(p)
		if err != nil {
			return nil, false
		}
		out = append(out, b)
	}
	return out, true
}

// refuseStream answers a log stream past a cap on streams held open: the
// caller's (#169), or one sign-in's to a demo account (#200).
func refuseStream(c *gin.Context) {
	c.Header("Retry-After", "10")
	writeError(c, http.StatusTooManyRequests, "too-many-streams",
		"too many log streams open for this caller; close one and retry")
}

// streamSlots caps how many log streams each caller holds open at once.
//
// The per-minute rate limiter cannot do this. It prices opening a stream and
// nothing after, because a follow that stays up for an hour should not keep
// spending budget — so it bounds how often a caller opens streams and says
// nothing about how many it keeps. Each open stream holds a goroutine per pod
// and an apiserver connection for as long as it lives (#169).
//
// In-process and per replica, like the rate limiter, for the same reason: the
// backend runs one replica, and with N the effective cap is N× this, which
// still bounds the load. Keyed by OIDC subject, also like the rate limiter.
//
// The map only holds callers with at least one stream open — an entry is
// removed when its count reaches zero — so it is bounded by open streams rather
// than by every subject ever seen, and needs no LRU.
type streamSlots struct {
	mu   sync.Mutex
	cap  int
	held map[string]int
}

func newStreamSlots(limit int) *streamSlots {
	if limit <= 0 {
		limit = defaultLogStreamsPerCaller
	}
	return &streamSlots{cap: limit, held: map[string]int{}}
}

// tryAcquire takes a slot for key if it has one free. Check and increment
// happen under one lock: as two steps, a burst of tabs opening together would
// all pass the check and overshoot the cap.
func (s *streamSlots) tryAcquire(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.held[key] >= s.cap {
		return false
	}
	s.held[key]++
	return true
}

// release gives back a slot taken by tryAcquire. A release with nothing held
// is a no-op rather than a credit — otherwise a stray double release would
// quietly raise that caller's cap by one, every time it happened.
func (s *streamSlots) release(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch n := s.held[key]; {
	case n <= 1:
		delete(s.held, key)
	default:
		s.held[key] = n - 1
	}
}
