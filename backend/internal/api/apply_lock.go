package api

import "context"

// lockApply takes the lock that keeps one request's ownership check and apply
// from interleaving with another's in the same namespace of the same apiserver
// (#191). Keyed by the normalized address, so two registrations of one
// apiserver (#195) share it.
func (h *Handlers) lockApply(ctx context.Context, apiURL, namespace string) (func(), error) {
	return h.deps.Store.LockApply(ctx, normalizeAPIURL(apiURL)+" "+namespace)
}
