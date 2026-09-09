package api

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRateLimiter_AllowsTheBurstThenRefuses(t *testing.T) {
	rl := newRateLimiter(5, 16)
	now := time.Now()
	for i := 0; i < 5; i++ {
		require.True(t, rl.allow("alice", now), "request %d should be inside the burst", i+1)
	}
	require.False(t, rl.allow("alice", now), "the 6th in the same instant must be refused")
}

// One noisy caller must not spend anyone else's budget.
func TestRateLimiter_IsPerCaller(t *testing.T) {
	rl := newRateLimiter(2, 16)
	now := time.Now()
	require.True(t, rl.allow("alice", now))
	require.True(t, rl.allow("alice", now))
	require.False(t, rl.allow("alice", now))
	require.True(t, rl.allow("bob", now), "bob has his own bucket")
}

func TestRateLimiter_RefillsOverTime(t *testing.T) {
	rl := newRateLimiter(60, 16) // one token per second
	now := time.Now()
	for i := 0; i < 60; i++ {
		require.True(t, rl.allow("alice", now))
	}
	require.False(t, rl.allow("alice", now))
	require.True(t, rl.allow("alice", now.Add(time.Second)), "a second buys one token")
	require.False(t, rl.allow("alice", now.Add(time.Second)))
}

// Idle time must not bank unlimited credit.
func TestRateLimiter_CapsAtTheBurst(t *testing.T) {
	rl := newRateLimiter(3, 16)
	now := time.Now()
	require.True(t, rl.allow("alice", now))
	later := now.Add(time.Hour)
	for i := 0; i < 3; i++ {
		require.True(t, rl.allow("alice", later))
	}
	require.False(t, rl.allow("alice", later), "an hour idle still only refills to the burst")
}

// The bucket map is bounded, so cycling identities cannot grow it without end.
func TestRateLimiter_EvictsColdCallers(t *testing.T) {
	rl := newRateLimiter(1, 2)
	now := time.Now()
	require.True(t, rl.allow("a", now))
	require.True(t, rl.allow("b", now))
	require.True(t, rl.allow("c", now)) // evicts "a"
	require.Equal(t, 2, rl.buckets.Len())
}
