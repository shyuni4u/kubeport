// Package session keeps the sessions table from growing without bound.
//
// Sessions are created by the Next.js BFF and expire on their own — every read
// filters on `expires_at > now()`. Nothing deleted the expired rows, so they
// accumulated forever, each still holding an AES-GCM encrypted id_token and
// refresh token. That is storage we pay for on a single-node Always Free box,
// backup weight, and credentials kept long after they stopped being useful.
package session

import (
	"context"
	"log"
	"time"
)

// Sweeper is the store method the reaper needs. Narrow on purpose so tests
// don't need a database.
type Sweeper interface {
	DeleteExpiredSessions(ctx context.Context, batchSize int32) (int64, error)
}

const (
	// DefaultInterval is a compromise: expired sessions are already unusable,
	// so the only cost of waiting is storage. Hourly keeps the table small
	// without adding meaningful load.
	DefaultInterval = time.Hour
	// DefaultBatchSize bounds one DELETE so a large backlog is worked off over
	// several passes instead of locking the table while logins are writing to
	// it.
	DefaultBatchSize = 1000
	// maxPassesPerTick stops a single tick from looping on a huge backlog; the
	// remainder is picked up next tick.
	maxPassesPerTick = 20
	// MinInterval guards against a typo in KBP_SESSION_REAP_INTERVAL turning a
	// housekeeping job into a self-inflicted DoS on a single-node Postgres.
	MinInterval = time.Minute
)

// Reap deletes expired sessions in bounded batches until a pass comes back
// short (or the cap is hit) and returns the total removed.
func Reap(ctx context.Context, s Sweeper, batchSize int32) (int64, error) {
	var total int64
	for i := 0; i < maxPassesPerTick; i++ {
		n, err := s.DeleteExpiredSessions(ctx, batchSize)
		if err != nil {
			// Return what we managed so the caller can log honestly.
			return total, err
		}
		total += n
		if n < int64(batchSize) {
			break
		}
	}
	return total, nil
}

// StartReaper runs Reap on a ticker until ctx is cancelled. It sweeps once at
// startup so a long-stopped deployment doesn't wait an hour to catch up.
//
// Safe to run on several replicas: the batch selects rows FOR UPDATE SKIP
// LOCKED in a stable order, so concurrent sweepers take disjoint batches
// instead of racing for the same rows. Leader election would only save the odd
// empty query, and is better introduced with the release reconciler (Plan 12)
// that actually needs it.
//
// Each pass gets its own deadline: without one, a wedged connection would park
// the goroutine forever and no later tick would ever run.
func StartReaper(ctx context.Context, s Sweeper, interval time.Duration, batchSize int32) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	if interval < MinInterval {
		log.Printf("session reaper: interval %s is below the %s floor; using the floor", interval, MinInterval)
		interval = MinInterval
	}
	if batchSize <= 0 {
		batchSize = DefaultBatchSize
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			passCtx, cancel := context.WithTimeout(ctx, interval/2)
			n, err := Reap(passCtx, s, batchSize)
			cancel()
			if err != nil {
				log.Printf("session reaper: %v (removed %d before failing)", err, n)
			} else if n > 0 {
				log.Printf("session reaper: removed %d expired sessions", n)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}
