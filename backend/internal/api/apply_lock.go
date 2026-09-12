package api

import (
	"context"
	"time"
)

// applyLockWait bounds how long a request waits for another request's check
// and apply in the same namespace to finish. Past it the request fails rather
// than hanging behind a cluster that stopped answering (security review).
const applyLockWait = 30 * time.Second

// lockApply takes the lock that keeps one request's ownership check and apply
// from interleaving with another's in the same namespace of the same apiserver
// (#191). Keyed by the normalized address, so two registrations of one
// apiserver (#195) share it. The deadline bounds the wait only; once taken, the
// lock is held until the returned function runs.
func (h *Handlers) lockApply(ctx context.Context, apiURL, namespace string) (func(), error) {
	waitCtx, cancel := context.WithTimeout(ctx, applyLockWait)
	defer cancel()
	return h.deps.Store.LockApply(waitCtx, normalizeAPIURL(apiURL)+" "+namespace)
}
