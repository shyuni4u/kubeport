package api

import (
	"context"
	"time"
)

// applyLockWait bounds how long a request waits for another request's check
// and apply in the same namespace to finish. Past it the request fails rather
// than hanging behind a cluster that stopped answering (security review).
const applyLockWait = 30 * time.Second

// applyLockHold bounds the cluster calls made while the lock is held — the
// ownership check, stamping and the apply. Without it a cluster that stopped
// answering, or a manifest with thousands of objects, held a lock connection
// for as long as the client kept the request open, and eight such requests
// held every one (security review). An apply cut short fails through its
// usual path: a create deletes what it applied, an update answers 502.
const applyLockHold = 60 * time.Second

// lockApply takes the lock that keeps one request's ownership check and apply
// from interleaving with another's in the same namespace of the same apiserver
// (#191). Keyed by the normalized address, so two registrations of one
// apiserver (#195) share it.
//
// It returns the context the locked cluster calls must use, bounded by
// applyLockHold, and the function that ends it and releases the lock.
func (h *Handlers) lockApply(ctx context.Context, apiURL, namespace string) (context.Context, func(), error) {
	waitCtx, cancelWait := context.WithTimeout(ctx, applyLockWait)
	defer cancelWait()
	release, err := h.deps.Store.LockApply(waitCtx, normalizeAPIURL(apiURL)+" "+namespace)
	if err != nil {
		return nil, nil, err
	}
	held, cancelHeld := context.WithTimeout(ctx, applyLockHold)
	return held, func() {
		cancelHeld()
		release()
	}, nil
}
