package main

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/store"
)

// Issue #306. reset deleted every demo template version in one statement, so
// a single non-demo release pointing at one of them made the statement fail and
// be skipped: every demo template and every version survived, including ones a
// visitor had published. Now only what a non-demo release references is kept.
func TestReset_KeepsOnlyTheVersionsANonDemoReleaseHolds(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	// A cleanup, not a defer: the cleanup below needs the connection, and a
	// defer would close it first. Cleanups run last-registered first.
	t.Cleanup(func() { conn.Close(ctx) })

	all := fixtures.All()
	require.Greater(t, len(all), 1, "the test needs a held and an unheld fixture")
	held := all[0]
	tpl, err := s.st.GetTemplateByName(ctx, held.Name)
	require.NoError(t, err)

	// An operator — not a demo account — deployed from the demo template.
	stamp := time.Now().Format("150405.000000")
	operator, err := s.st.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "reset-operator-" + stamp,
		Email:       store.PgText("reset-operator-" + stamp + "@example.com"),
	})
	require.NoError(t, err)
	var clusterID, releaseID pgtype.UUID
	require.NoError(t, conn.QueryRow(ctx,
		`INSERT INTO clusters (name, api_url, oidc_issuer_url) VALUES ($1, $2, 'http://issuer') RETURNING id`,
		"reset-test-"+stamp, "https://reset-test.example/"+stamp).Scan(&clusterID))
	require.NoError(t, conn.QueryRow(ctx,
		`INSERT INTO releases (name, template_version_id, cluster_id, namespace, values_json, rendered_yaml, created_by_user_id)
		 VALUES ($1, $2, $3, 'default', '{}', '', $4) RETURNING id`,
		"reset-test-"+stamp, tpl.CurrentVersionID, clusterID, operator.ID).Scan(&releaseID))
	// Registered after newTestSeeder, so it runs before clearFixtures, which
	// refuses to drop a template a non-demo release still points at.
	t.Cleanup(func() {
		_, _ = conn.Exec(ctx, `DELETE FROM releases WHERE id = $1`, releaseID)
		_, _ = conn.Exec(ctx, `DELETE FROM clusters WHERE id = $1`, clusterID)
	})

	require.NoError(t, (&preflight{}).reset(ctx, testDSN(), testDemoDomain))

	vs := versionsOf(t, s, ctx, held.Name)
	require.Len(t, vs, 1, "only the version the release points at survives")
	require.Equal(t, tpl.CurrentVersionID, vs[0].ID)
	for _, f := range all[1:] {
		_, err := s.st.GetTemplateByName(ctx, f.Name)
		require.Truef(t, errors.Is(err, pgx.ErrNoRows), "%s holds no reference and must be deleted, got %v", f.Name, err)
	}
}
