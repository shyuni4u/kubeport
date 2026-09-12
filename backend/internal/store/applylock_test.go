package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"kubeport/internal/store"
)

// #191: the apply lock serialises requests for one key and leaves other keys
// alone, and a waiter gives up with its context.
func TestLockApply_SerialisesOneKey(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	key := "https://apply-lock-" + time.Now().Format("150405.000000") + " demo"
	release, err := s.LockApply(ctx, key)
	require.NoError(t, err)

	waitCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	_, err = s.LockApply(waitCtx, key)
	require.True(t, errors.Is(err, context.DeadlineExceeded), "a second holder of the same key must wait: %v", err)

	other, err := s.LockApply(ctx, key+"-other")
	require.NoError(t, err, "another namespace is another lock")
	other()

	release()
	again, err := s.LockApply(ctx, key)
	require.NoError(t, err, "released, the key is free again")
	again()
}

// A burst of waiters must not use up the pool: the holder still gets a
// connection for its own queries while others wait.
func TestLockApply_WaitersDoNotHoldConnections(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t))
	require.NoError(t, err)
	defer s.Close()

	key := "https://apply-lock-burst-" + time.Now().Format("150405.000000") + " demo"
	release, err := s.LockApply(ctx, key)
	require.NoError(t, err)

	// Waiters poll, so thirty-two of them take their turns over a while once
	// the lock is free; the bound only keeps a broken lock from hanging the run.
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	done := make(chan error, 32)
	for range 32 {
		go func() {
			rel, err := s.LockApply(waitCtx, key)
			if err == nil {
				rel()
			}
			done <- err
		}()
	}

	queryCtx, cancelQuery := context.WithTimeout(ctx, time.Second)
	defer cancelQuery()
	_, err = s.ListClusters(queryCtx)
	require.NoError(t, err, "the holder must still get a connection while 32 requests wait")

	release()
	for range 32 {
		require.NoError(t, <-done)
	}
}

// codex and security review of #191: holders of different keys, more of them
// than the query pool has connections, must still leave that pool free — a
// holder goes on to write or delete its release row while it holds the lock.
func TestLockApply_HoldersDoNotTakeQueryConnections(t *testing.T) {
	ctx := context.Background()
	s, err := store.NewStore(ctx, testDSN(t)+"&pool_max_conns=2")
	require.NoError(t, err)
	defer s.Close()

	stamp := time.Now().Format("150405.000000")
	var releases []func()
	for _, ns := range []string{"a", "b", "c"} {
		release, err := s.LockApply(ctx, "https://apply-lock-holders-"+stamp+" "+ns)
		require.NoError(t, err)
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()

	queryCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err = s.ListClusters(queryCtx)
	require.NoError(t, err, "three holders on a two-connection query pool left no connection for a query")
}
