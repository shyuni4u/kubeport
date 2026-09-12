package api

import (
	"bytes"
	"encoding/base64"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// codex review of #200: a JWS signature's base64url text has spare trailing
// bits the verifier ignores, so one signed token has several spellings that all
// verify. Each must name the same sign-in, or one sign-in gets a cap per
// spelling.
func TestLoginKey_EverySpellingOfOneSignatureIsOneSignIn(t *testing.T) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	sig := bytes.Repeat([]byte{0xa5}, 256) // an RS256 signature is 256 bytes
	canonical := base64.RawURLEncoding.EncodeToString(sig)

	// 256 bytes is 2048 bits in 342 characters of 6: the last carries 4 spare.
	last := strings.IndexByte(alphabet, canonical[len(canonical)-1])
	require.Zero(t, last&0x0f, "a canonical encoding leaves the spare bits clear")
	variant := canonical[:len(canonical)-1] + string(alphabet[last|0x05])
	decoded, err := base64.RawURLEncoding.DecodeString(variant)
	require.NoError(t, err, "the lenient decoder the verifier uses accepts the variant")
	require.Equal(t, sig, decoded, "the variant is the same signature")

	token := "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0." + canonical
	respelled := "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0." + variant
	require.NotEqual(t, token, respelled)
	require.Equal(t, loginKey(token), loginKey(respelled))

	other := "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0." +
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 256))
	require.NotEqual(t, loginKey(token), loginKey(other), "another sign-in's signature is another key")
}

// A log stream costs one rate-limit token to open and nothing after that, so
// the per-minute budget bounds how often a caller opens streams, not how many
// it holds. A tab left open holds a goroutine per pod and an apiserver
// connection for as long as it stays open, and the demo's two identities are
// shared by every visitor — so one caller's open tabs are everyone's (#169).

func TestStreamSlots_RefusesPastTheCap(t *testing.T) {
	s := newStreamSlots(2)
	require.True(t, s.tryAcquire("alice"))
	require.True(t, s.tryAcquire("alice"))
	require.False(t, s.tryAcquire("alice"), "a third concurrent stream must be refused")
}

// One caller's open tabs must not use up anyone else's.
func TestStreamSlots_IsPerCaller(t *testing.T) {
	s := newStreamSlots(1)
	require.True(t, s.tryAcquire("alice"))
	require.False(t, s.tryAcquire("alice"))
	require.True(t, s.tryAcquire("bob"), "bob holds nothing yet")
}

func TestStreamSlots_ReleaseFreesASlot(t *testing.T) {
	s := newStreamSlots(1)
	require.True(t, s.tryAcquire("alice"))
	s.release("alice")
	require.True(t, s.tryAcquire("alice"), "closing a stream has to give its slot back")
}

// The map holds only callers with a stream open right now. Keeping a zero entry
// for every subject that ever opened one would grow without bound — the
// rate limiter needs an LRU for exactly that reason; this does not, provided it
// forgets.
func TestStreamSlots_ForgetsCallersWithNothingOpen(t *testing.T) {
	s := newStreamSlots(4)
	require.True(t, s.tryAcquire("alice"))
	s.release("alice")
	require.Empty(t, s.held)
}

// A release with no matching acquire must not bank a slot. If it did, a stray
// double release would quietly raise that caller's cap by one, every time.
func TestStreamSlots_AReleaseWithoutAnAcquireBanksNothing(t *testing.T) {
	s := newStreamSlots(1)
	s.release("alice")
	require.True(t, s.tryAcquire("alice"))
	require.False(t, s.tryAcquire("alice"), "the stray release must not have made room for a second")
}

// Most tests build the router from a bare config.Config{}. A zero cap has to
// mean "the default", or every one of them would start refusing streams.
func TestStreamSlots_ZeroFallsBackToTheDefault(t *testing.T) {
	require.Equal(t, defaultLogStreamsPerCaller, newStreamSlots(0).cap)
	require.Equal(t, defaultLogStreamsPerCaller, newStreamSlots(-3).cap)
}

// Acquire is check-and-increment. Done as two unsynchronised steps, a burst of
// tabs opening together would all pass the check and overshoot the cap.
func TestStreamSlots_HoldsTheCapUnderConcurrency(t *testing.T) {
	const cap, callers = 10, 200
	s := newStreamSlots(cap)

	var granted atomic.Int32
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.tryAcquire("demo-user") {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()

	require.EqualValues(t, cap, granted.Load())
}

// Most tests build the router from a bare config.Config{}. A zero lifetime has
// to mean "the default", or every stream in those tests would end the instant
// it opened.
func TestLogStreamLifetime_ZeroFallsBackToTheDefault(t *testing.T) {
	require.Equal(t, defaultLogStreamLifetime, logStreamLifetime(0))
	require.Equal(t, defaultLogStreamLifetime, logStreamLifetime(-time.Second))
	require.Equal(t, 90*time.Second, logStreamLifetime(90*time.Second))
}
