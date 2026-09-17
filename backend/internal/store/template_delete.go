package store

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
)

// DeleteTemplate cascades to versions. Release foreign keys reject the entire
// statement atomically when any version is referenced, including concurrent use.
func (q *Queries) DeleteTemplate(ctx context.Context, id pgtype.UUID) error {
	var deleted pgtype.UUID
	return q.db.QueryRow(ctx, "DELETE FROM templates WHERE id = $1 RETURNING id", id).Scan(&deleted)
}
