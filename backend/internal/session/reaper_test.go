package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeSweeper struct {
	mu        sync.Mutex
	remaining int64
	calls     []int32
	err       error
}

func (f *fakeSweeper) DeleteExpiredSessions(_ context.Context, batchSize int32) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, batchSize)
	if f.err != nil {
		return 0, f.err
	}
	n := int64(batchSize)
	if f.remaining < n {
		n = f.remaining
	}
	f.remaining -= n
	return n, nil
}

func (f *fakeSweeper) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func TestReap_StopsWhenAPassComesBackShort(t *testing.T) {
	s := &fakeSweeper{remaining: 250}
	n, err := Reap(context.Background(), s, 100)
	require.NoError(t, err)
	require.Equal(t, int64(250), n)
	// 100, 100, 50 → the short pass ends it.
	require.Equal(t, 3, s.callCount())
}

func TestReap_NothingToDoIsOneQuery(t *testing.T) {
	s := &fakeSweeper{remaining: 0}
	n, err := Reap(context.Background(), s, 100)
	require.NoError(t, err)
	require.Zero(t, n)
	require.Equal(t, 1, s.callCount())
}

// A backlog far larger than one tick can handle must not spin: the rest waits
// for the next tick rather than holding the table.
func TestReap_CapsPassesPerTick(t *testing.T) {
	s := &fakeSweeper{remaining: 1_000_000}
	n, err := Reap(context.Background(), s, 100)
	require.NoError(t, err)
	require.Equal(t, int64(maxPassesPerTick*100), n)
	require.Equal(t, maxPassesPerTick, s.callCount())
}

func TestReap_ReportsPartialProgressOnError(t *testing.T) {
	s := &fakeSweeper{remaining: 0, err: errors.New("connection refused")}
	n, err := Reap(context.Background(), s, 100)
	require.Error(t, err)
	require.Zero(t, n)
}

// A typo like KBP_SESSION_REAP_INTERVAL=100ms must not turn housekeeping into
// a self-inflicted DoS on a single-node Postgres.
func TestStartReaper_ClampsAnAbsurdInterval(t *testing.T) {
	s := &fakeSweeper{remaining: 0}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartReaper(ctx, s, time.Millisecond, 100)

	require.Eventually(t, func() bool { return s.callCount() >= 1 }, time.Second, 5*time.Millisecond)
	// At 1ms an unclamped ticker would have fired hundreds of times by now.
	time.Sleep(100 * time.Millisecond)
	require.Equal(t, 1, s.callCount(), "interval should have been clamped to the floor")
}

func TestStartReaper_SweepsImmediatelyAndStopsOnCancel(t *testing.T) {
	s := &fakeSweeper{remaining: 5}
	ctx, cancel := context.WithCancel(context.Background())
	// A long interval proves the first sweep does not wait for a tick.
	StartReaper(ctx, s, time.Hour, 100)

	require.Eventually(t, func() bool { return s.callCount() >= 1 }, time.Second, 5*time.Millisecond)
	cancel()

	// After cancel the goroutine returns; no further calls accumulate.
	settled := s.callCount()
	time.Sleep(20 * time.Millisecond)
	require.Equal(t, settled, s.callCount())
}
