package store

import (
	"context"
	"time"
)

// applyLockSeed seeds the hash that turns an apply lock's key into an advisory
// lock id ("kbp_aply"), so these ids are drawn apart from any other lock taken
// by hashing text.
const applyLockSeed int64 = 0x6b62705f61706c79

// applyLockConns caps the connections apply locks hold, and so how many
// namespaces can be between an ownership check and the end of their apply at
// once. Requests past it wait for a lock connection, not for the database.
const applyLockConns = 8

// LockApply takes the advisory lock for key — a cluster's apiserver and a
// namespace — and returns the function that releases it (#191).
//
// A release's ownership check and its apply are separate calls to the
// cluster. Two requests deploying into one namespace could both find an
// object free and then both apply it, the second taking the first's object
// over the way #161 described. Holding this lock from the check through the
// apply makes the second request's check run after the first apply, where it
// sees the object carrying the first release's id.
//
// A session lock on a connection of its own, not a transaction lock: it is
// held across cluster calls that can take seconds, and an open transaction
// idling that long would pin more than the lock. It covers every kubeport
// replica sharing the database, not another installation applying to the same
// cluster.
//
// Locks live on connections from a pool of their own, never the one queries
// use. A holder goes on to query — an update writes the release row after its
// apply, a failed create deletes its row — and with locks on the query pool, as
// many holders as that pool's size would each wait for a connection none of
// them could free (codex review).
//
// A waiter does not hold a lock connection while it waits: it tries the lock,
// gives the connection back when it is taken, and tries again, so requests for
// one busy namespace do not keep other namespaces from their turn. Waiting ends
// with ctx.
//
// The release runs with a fresh deadline, since it usually runs as ctx ends. A
// connection that cannot be unlocked is closed rather than returned to the
// pool, because closing its session is what frees the lock then.
func (s *Store) LockApply(ctx context.Context, key string) (func(), error) {
	backoff := 20 * time.Millisecond
	for {
		conn, err := s.lockPool.Acquire(ctx)
		if err != nil {
			return nil, err
		}
		var taken bool
		err = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtextextended($1, $2))", key, applyLockSeed).Scan(&taken)
		if err != nil {
			// The statement may have taken the lock before ctx cut the reply
			// off; closing the session frees it either way.
			_ = conn.Hijack().Close(context.Background())
			return nil, err
		}
		if taken {
			return func() {
				unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if _, err := conn.Exec(unlockCtx, "SELECT pg_advisory_unlock(hashtextextended($1, $2))", key, applyLockSeed); err != nil {
					_ = conn.Hijack().Close(unlockCtx)
					return
				}
				conn.Release()
			}, nil
		}
		conn.Release()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 250*time.Millisecond {
			backoff *= 2
		}
	}
}
