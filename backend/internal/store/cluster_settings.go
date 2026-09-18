package store

import (
	"context"
	"time"
)

// The API endpoint is intentionally immutable: existing releases belong to
// that cluster and must never silently target a different control plane.
func (s *Store) UpdateClusterSettings(ctx context.Context, name, display, ca, issuer, namespace string, updated time.Time) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE clusters SET display_name=$2, ca_bundle=$3, oidc_issuer_url=$4, default_namespace=$5, updated_at=now() WHERE name=$1 AND updated_at=$6`, name, display, ca, issuer, namespace, updated)
	return tag.RowsAffected() == 1, err
}
