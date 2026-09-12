package store

import (
	"context"
	"time"
)

// applyLockSeed seeds the hash that turns an apply lock's key into an advisory
// lock id ("kbp_aply"), so these ids are drawn apart from any other lock taken
// by hashing text.
const applyLockSeed int64 = 0x6b62705f61706c79

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
// A waiter does not hold a connection while it waits: it tries the lock, gives
// the connection back when it is taken, and tries again. Blocking in
// pg_advisory_lock would park one pooled connection per waiting request, and a
// burst of deploys could leave the holder unable to get the connection its own
// rollback needs. Waiting ends with ctx.
//
// The release runs with a fresh deadline, since it usually runs as ctx ends. A
// connection that cannot be unlocked is closed rather than returned to the
// pool, because closing its session is what frees the lock then.
func (s *Store) LockApply(ctx context.Context, key string) (func(), error) {
	backoff := 20 * time.Millisecond
	for {
		conn, err := s.pool.Acquire(ctx)
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
