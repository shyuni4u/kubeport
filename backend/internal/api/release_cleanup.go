package api

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// A failed create undoes itself in two steps: delete what reached the cluster,
// then delete the release row. They get separate budgets (#282). The common
// reason an apply fails is a cluster that does not answer, and the cleanup
// goes to that same cluster; sharing one deadline let DeleteByRelease spend
// all of it, the row delete then failed at once, and the create ended in a 502
// that still left a release behind — listed as cluster-unreachable, holding
// its name against a retry, removable only by an admin's force delete.
//
// Variables, not constants, so a test can shorten them.
var (
	// releaseCleanupK8sTimeout bounds deleting a failed create's objects.
	releaseCleanupK8sTimeout = 30 * time.Second
	// releaseRowDeleteTimeout bounds deleting a failed create's row — one
	// statement against our own database, started after the cluster cleanup
	// has given up.
	releaseRowDeleteTimeout = 10 * time.Second
)

// dropReleaseRow deletes the row of a create that did not go through, on a
// context of its own: the request's may already be over, and whatever ran
// before it must not have used up its time.
func (h *Handlers) dropReleaseRow(id pgtype.UUID, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), releaseRowDeleteTimeout)
	defer cancel()
	if err := h.deps.Store.DeleteRelease(ctx, id); err != nil {
		log.Printf("rollback: failed to delete release %s from DB: %v", name, err)
	}
}
