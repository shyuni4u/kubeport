package api

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// mustAllow drops the wait duration for the cases that only care about the
// verdict.
func mustAllow(rl *rateLimiter, key string, now time.Time) bool {
	ok, _ := rl.allow(key, now)
	return ok
}

func TestRateLimiter_AllowsTheBurstThenRefuses(t *testing.T) {
	rl := newRateLimiter(5, 16)
	now := time.Now()
	for i := 0; i < 5; i++ {
		require.True(t, mustAllow(rl, "alice", now), "request %d should be inside the burst", i+1)
	}
	require.False(t, mustAllow(rl, "alice", now), "the 6th in the same instant must be refused")
}

// One noisy caller must not spend anyone else's budget.
func TestRateLimiter_IsPerCaller(t *testing.T) {
	rl := newRateLimiter(2, 16)
	now := time.Now()
	require.True(t, mustAllow(rl, "alice", now))
	require.True(t, mustAllow(rl, "alice", now))
	require.False(t, mustAllow(rl, "alice", now))
	require.True(t, mustAllow(rl, "bob", now), "bob has his own bucket")
}

func TestRateLimiter_RefillsOverTime(t *testing.T) {
	rl := newRateLimiter(60, 16) // one token per second
	now := time.Now()
	for i := 0; i < 60; i++ {
		require.True(t, mustAllow(rl, "alice", now))
	}
	require.False(t, mustAllow(rl, "alice", now))
	require.True(t, mustAllow(rl, "alice", now.Add(time.Second)), "a second buys one token")
	require.False(t, mustAllow(rl, "alice", now.Add(time.Second)))
}

// Idle time must not bank unlimited credit.
func TestRateLimiter_CapsAtTheBurst(t *testing.T) {
	rl := newRateLimiter(3, 16)
	now := time.Now()
	require.True(t, mustAllow(rl, "alice", now))
	later := now.Add(time.Hour)
	for i := 0; i < 3; i++ {
		require.True(t, mustAllow(rl, "alice", later))
	}
	require.False(t, mustAllow(rl, "alice", later), "an hour idle still only refills to the burst")
}

// The bucket map is bounded, so cycling identities cannot grow it without end.
func TestRateLimiter_EvictsColdCallers(t *testing.T) {
	rl := newRateLimiter(1, 2)
	now := time.Now()
	require.True(t, mustAllow(rl, "a", now))
	require.True(t, mustAllow(rl, "b", now))
	require.True(t, mustAllow(rl, "c", now)) // evicts "a"
	require.Equal(t, 2, rl.buckets.Len())
}

// A refusal has to say how long to wait, or a program either retries at once —
// defeating the limit — or sleeps an arbitrary constant.
func TestRateLimiter_ReportsHowLongToWait(t *testing.T) {
	rl := newRateLimiter(60, 16) // one token per second
	now := time.Now()
	for i := 0; i < 60; i++ {
		require.True(t, mustAllow(rl, "alice", now))
	}

	ok, wait := rl.allow("alice", now)
	require.False(t, ok)
	require.Greater(t, wait, time.Duration(0))
	require.LessOrEqual(t, wait, time.Second, "one token per second, so never more than a second out")

	// Waiting exactly that long is enough.
	require.True(t, mustAllow(rl, "alice", now.Add(wait)))
}

func TestRateLimiter_ReportsNoWaitWhenAllowed(t *testing.T) {
	rl := newRateLimiter(5, 16)
	ok, wait := rl.allow("alice", time.Now())
	require.True(t, ok)
	require.Zero(t, wait)
}
