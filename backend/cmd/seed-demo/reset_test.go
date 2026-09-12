package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/store"
)

// connect opens a connection closed as a cleanup, not a defer: cleanups that
// need it are registered after it and run first.
func connect(t *testing.T, ctx context.Context) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close(ctx) })
	return conn
}

// holdWithOperatorRelease makes an operator — not a demo account — deploy
// version, the way a non-demo admin can deploy from a demo template.
func holdWithOperatorRelease(t *testing.T, ctx context.Context, s *templateSeeder, conn *pgx.Conn, version pgtype.UUID) {
	t.Helper()
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
		"reset-test-"+stamp, version, clusterID, operator.ID).Scan(&releaseID))
	// Runs before clearFixtures, which refuses to drop a template a non-demo
	// release still points at.
	t.Cleanup(func() {
		_, _ = conn.Exec(ctx, `DELETE FROM releases WHERE id = $1`, releaseID)
		_, _ = conn.Exec(ctx, `DELETE FROM clusters WHERE id = $1`, clusterID)
	})
}

// Issue #306. reset deleted every demo template version in one statement, so
// a single non-demo release pointing at one of them made the statement fail and
// be skipped: every demo template and every version survived, including ones a
// visitor had published. Now only what a non-demo release references is kept.
func TestReset_KeepsOnlyTheVersionsANonDemoReleaseHolds(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	conn := connect(t, ctx)

	all := fixtures.All()
	require.Greater(t, len(all), 1, "the test needs a held and an unheld fixture")
	held := all[0]
	tpl, err := s.st.GetTemplateByName(ctx, held.Name)
	require.NoError(t, err)
	holdWithOperatorRelease(t, ctx, s, conn, tpl.CurrentVersionID)

	require.NoError(t, (&preflight{}).reset(ctx, testDSN(), testDemoDomain))

	vs := versionsOf(t, s, ctx, held.Name)
	require.Len(t, vs, 1, "only the version the release points at survives")
	require.Equal(t, tpl.CurrentVersionID, vs[0].ID)
	for _, f := range all[1:] {
		_, err := s.st.GetTemplateByName(ctx, f.Name)
		require.Truef(t, errors.Is(err, pgx.ErrNoRows), "%s holds no reference and must be deleted, got %v", f.Name, err)
	}
}

// Security review of 03749a8: seed releases pinned v1. When the version a
// non-demo release keeps is not the fixture's content — here v1, after the
// fixture changed — repair deprecates it and publishes the fixture as a new
// version, and a release pinned to v1 would fail the reset Job. The version the
// seed releases deploy is the repaired current one.
func TestReset_SeedReleasesDeployTheRepairedVersion(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	conn := connect(t, ctx)

	held := fixtures.All()[0]
	tpl, err := s.st.GetTemplateByName(ctx, held.Name)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `UPDATE template_versions SET resources_yaml = $2 WHERE id = $1`, tpl.CurrentVersionID, visitorYAML)
	require.NoError(t, err)
	holdWithOperatorRelease(t, ctx, s, conn, tpl.CurrentVersionID)

	require.NoError(t, (&preflight{}).reset(ctx, testDSN(), testDemoDomain))
	require.NoError(t, s.Run(ctx))
	versions, err := s.currentVersions(ctx)
	require.NoError(t, err)

	for _, f := range fixtures.All() {
		_, ok := versions[f.Name]
		require.Truef(t, ok, "%s has no version for its seed release", f.Name)
	}
	require.NotEqual(t, int32(1), versions[held.Name], "v1 was deprecated; the seed release must not pin it")
	for _, v := range versionsOf(t, s, ctx, held.Name) {
		switch {
		case v.Version == versions[held.Name]:
			require.Equal(t, "published", v.Status)
			require.Equal(t, held.ResourcesYAML, v.ResourcesYaml)
		case v.ID == tpl.CurrentVersionID:
			require.Equal(t, "deprecated", v.Status)
		}
	}
}
