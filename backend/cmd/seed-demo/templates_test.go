package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/store"
)

// These exercise the database path the demo reset CronJob takes. They need the
// compose postgres (docs/testing.md); the fixture names are global, so each
// test clears them first and drops them again on the way out.

func testDSN() string {
	if dsn := os.Getenv("TEST_DATABASE_URL"); dsn != "" {
		return dsn
	}
	return "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
}

func newTestSeeder(t *testing.T) (*templateSeeder, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := store.NewStore(ctx, testDSN())
	require.NoError(t, err)
	t.Cleanup(st.Close)

	owner, err := st.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: "seed-test-" + time.Now().Format("150405.000000"),
		Email:       store.PgText("seed-test-" + time.Now().Format("150405.000000") + "@demo.kubeport"),
		DisplayName: store.PgText("seed test"),
	})
	require.NoError(t, err)

	clearFixtures(t, ctx)
	t.Cleanup(func() { clearFixtures(t, ctx) })
	return &templateSeeder{st: st, owner: owner}, ctx
}

// clearFixtures drops the seeded catalog — including releases deployed from it,
// which hold a foreign key to its versions. Everything it removes is demo data
// that `scripts/e2e/seed.sh` (or the reset CronJob) puts back.
func clearFixtures(t *testing.T, ctx context.Context) {
	t.Helper()
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)

	for _, f := range fixtures.All() {
		for _, sql := range []string{
			`UPDATE templates SET current_version_id = NULL WHERE name = $1`,
			`DELETE FROM releases WHERE template_version_id IN (
			   SELECT tv.id FROM template_versions tv
			   JOIN templates t ON t.id = tv.template_id WHERE t.name = $1)`,
			`DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE name = $1)`,
			`DELETE FROM templates WHERE name = $1`,
		} {
			_, err := conn.Exec(ctx, sql, f.Name)
			require.NoError(t, err, f.Name)
		}
	}
}

func versionsOf(t *testing.T, s *templateSeeder, ctx context.Context, name string) []store.TemplateVersion {
	t.Helper()
	vs, err := s.st.ListTemplateVersions(ctx, name)
	require.NoError(t, err)
	return vs
}

func TestTemplateSeeder_SeedsPublishedV1AndDraft(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))

	for _, f := range fixtures.All() {
		tpl, err := s.st.GetTemplateByName(ctx, f.Name)
		require.NoError(t, err, f.Name)
		require.Equal(t, s.owner.ID, tpl.OwnerUserID, "%s must be demo-owned so resetDB collects it", f.Name)
		require.False(t, tpl.OwningTeamID.Valid, "%s is a global template", f.Name)
		require.True(t, tpl.CurrentVersionID.Valid, "%s must point at a published version", f.Name)

		vs := versionsOf(t, s, ctx, f.Name)
		require.Len(t, vs, 2, f.Name)
		byVersion := map[int32]store.TemplateVersion{}
		for _, v := range vs {
			byVersion[v.Version] = v
		}
		require.Equal(t, "published", byVersion[1].Status, "%s v1 is what the catalog deploys", f.Name)
		require.Equal(t, "draft", byVersion[2].Status, "%s v2 is what demo-admin edits", f.Name)
		require.Equal(t, draftNotes, byVersion[2].Notes.String, f.Name)
		require.Equal(t, f.ResourcesYAML, byVersion[1].ResourcesYaml, f.Name)
	}
}

func TestTemplateSeeder_IsIdempotent(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	before := versionsOf(t, s, ctx, fixtures.All()[0].Name)

	require.NoError(t, s.Run(ctx), "a second reset must not fail on the catalog it already wrote")

	after := versionsOf(t, s, ctx, fixtures.All()[0].Name)
	require.Len(t, after, len(before), "no extra versions on re-run")
}

func TestTemplateSeeder_RepairsDeletedDraft(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	name := fixtures.All()[0].Name

	// A demo visitor deleting the draft is expected — the next reset has to put
	// an editable version back, at the next free number.
	var draftID = versionsOf(t, s, ctx, name)[0].ID
	for _, v := range versionsOf(t, s, ctx, name) {
		if v.Status == "draft" {
			draftID = v.ID
		}
	}
	_, err := s.st.DeleteDraftTemplateVersion(ctx, draftID)
	require.NoError(t, err)

	require.NoError(t, s.Run(ctx))

	var drafts int
	for _, v := range versionsOf(t, s, ctx, name) {
		if v.Status == "draft" {
			drafts++
			require.Greater(t, v.Version, int32(1), "the recreated draft must not shadow published v1")
		}
	}
	require.Equal(t, 1, drafts)
}
