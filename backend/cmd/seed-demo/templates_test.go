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

const testDemoDomain = "demo.kubeport"

func newTestSeeder(t *testing.T) (*templateSeeder, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := store.NewStore(ctx, testDSN())
	require.NoError(t, err)
	t.Cleanup(st.Close)

	owner := newDemoUser(t, ctx, st, "seed-test")
	clearFixtures(t, ctx, testDemoDomain)
	t.Cleanup(func() { clearFixtures(t, ctx, testDemoDomain) })
	return &templateSeeder{st: st, owner: owner}, ctx
}

func newDemoUser(t *testing.T, ctx context.Context, st *store.Store, prefix string) store.User {
	t.Helper()
	id := prefix + "-" + time.Now().Format("150405.000000")
	u, err := st.UpsertUser(ctx, store.UpsertUserParams{
		OidcSubject: id,
		Email:       store.PgText(id + "@" + testDemoDomain),
		DisplayName: store.PgText(prefix),
	})
	require.NoError(t, err)
	return u
}

// clearFixtures drops the seeded catalog — including releases deployed from it,
// which hold a foreign key to its versions. Every statement is scoped to
// demo-owned rows, the same predicate resetDB uses: a fixture name is not
// reserved, so an unscoped delete here would take a real user's template and
// somebody else's releases with it. If a fixture name is held outside the demo
// domain the test skips instead, because seeding would (correctly) refuse it.
func clearFixtures(t *testing.T, ctx context.Context, demoDomain string) {
	t.Helper()
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)

	demoOwned := `owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($2))`
	like := "%@" + demoDomain
	for _, f := range fixtures.All() {
		var foreign bool
		require.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM templates WHERE name = $1 AND NOT (`+demoOwned+`))`,
			f.Name, like).Scan(&foreign))
		if foreign {
			t.Skipf("template %q exists outside the demo domain on this database — "+
				"seeding refuses to touch it; drop the row or point TEST_DATABASE_URL elsewhere", f.Name)
		}

		// Releases are scoped by who deployed them, not by who owns the template
		// — resetDB draws the line the same way. A real user can deploy from a
		// demo template, and dropping that row would leave their workload
		// running in the cluster with nothing in the database pointing at it.
		fromFixture := `template_version_id IN (
		   SELECT tv.id FROM template_versions tv
		   JOIN templates t ON t.id = tv.template_id
		   WHERE t.name = $1 AND t.` + demoOwned + `)`
		_, err := conn.Exec(ctx,
			`DELETE FROM releases WHERE `+fromFixture+
				` AND created_by_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($2))`,
			f.Name, like)
		require.NoError(t, err, f.Name)

		var held bool
		require.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM releases WHERE `+fromFixture+`)`, f.Name, like).Scan(&held))
		if held {
			t.Skipf("a non-demo release still points at %q on this database — "+
				"dropping the template would orphan it; clean it up or point TEST_DATABASE_URL elsewhere", f.Name)
		}

		for _, sql := range []string{
			`UPDATE templates SET current_version_id = NULL WHERE name = $1 AND ` + demoOwned,
			`DELETE FROM template_versions WHERE template_id IN (
			   SELECT id FROM templates WHERE name = $1 AND ` + demoOwned + `)`,
			`DELETE FROM templates WHERE name = $1 AND ` + demoOwned,
		} {
			_, err := conn.Exec(ctx, sql, f.Name, like)
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

// deployable reports what the catalog needs: the template points at a version
// that is actually published. A visitor deprecating v1 breaks this without
// changing which version the template points at.
func deployable(t *testing.T, s *templateSeeder, ctx context.Context, name string) bool {
	t.Helper()
	tpl, err := s.st.GetTemplateByName(ctx, name)
	require.NoError(t, err)
	for _, v := range versionsOf(t, s, ctx, name) {
		if v.ID == tpl.CurrentVersionID && v.Status == "published" {
			return true
		}
	}
	return false
}

func TestTemplateSeeder_RepairsDeprecatedCurrentVersion(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	name := fixtures.All()[0].Name

	// demo-admin can deprecate the published version during a visit; nothing
	// moves current_version_id, so the catalog entry stops being deployable.
	tpl, err := s.st.GetTemplateByName(ctx, name)
	require.NoError(t, err)
	_, err = s.st.SetTemplateVersionStatus(ctx, store.SetTemplateVersionStatusParams{
		ID: tpl.CurrentVersionID, Status: "deprecated",
	})
	require.NoError(t, err)
	require.False(t, deployable(t, s, ctx, name), "precondition")

	require.NoError(t, s.Run(ctx))
	require.True(t, deployable(t, s, ctx, name), "the next reset must make the catalog deployable again")
}

func TestTemplateSeeder_RepairsTemplateWithNoVersions(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	name := fixtures.All()[0].Name

	tpl, err := s.st.GetTemplateByName(ctx, name)
	require.NoError(t, err)
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `UPDATE templates SET current_version_id = NULL WHERE id = $1`, tpl.ID)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `DELETE FROM template_versions WHERE template_id = $1`, tpl.ID)
	require.NoError(t, err)

	require.NoError(t, s.Run(ctx))
	require.True(t, deployable(t, s, ctx, name), "a template row with no versions is invisible to visitors")
	var drafts int
	for _, v := range versionsOf(t, s, ctx, name) {
		if v.Status == "draft" {
			drafts++
		}
	}
	require.Equal(t, 1, drafts, "and demo-admin still needs something to edit")
}

// visitorYAML stands in for what a demo visitor writes into a draft: anything,
// including a Deployment that prints another visitor's Secret.
const visitorYAML = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: written-by-a-visitor }\n"

// rewriteDraft does what PATCH /v1/templates/:name/versions/:v lets any demo
// account do, and returns the draft's id.
func rewriteDraft(t *testing.T, s *templateSeeder, ctx context.Context, conn *pgx.Conn, name string) store.TemplateVersion {
	t.Helper()
	for _, v := range versionsOf(t, s, ctx, name) {
		if v.Status == "draft" {
			_, err := conn.Exec(ctx, `UPDATE template_versions SET resources_yaml = $2 WHERE id = $1`, v.ID, visitorYAML)
			require.NoError(t, err)
			return v
		}
	}
	t.Fatalf("%s has no draft", name)
	return store.TemplateVersion{}
}

// requireCatalogIsTheFixture asserts the version the catalog deploys carries
// the fixture's content and the visitor's draft is still only a draft.
func requireCatalogIsTheFixture(t *testing.T, s *templateSeeder, ctx context.Context, f fixtures.Template, draft store.TemplateVersion) {
	t.Helper()
	require.True(t, deployable(t, s, ctx, f.Name))
	tpl, err := s.st.GetTemplateByName(ctx, f.Name)
	require.NoError(t, err)
	for _, v := range versionsOf(t, s, ctx, f.Name) {
		if v.ID == tpl.CurrentVersionID {
			require.Equal(t, f.ResourcesYAML, v.ResourcesYaml, "the catalog must deploy the fixture, not the visitor's draft")
			require.True(t, v.PublishedAt.Valid)
		}
		if v.ID == draft.ID {
			require.Equal(t, "draft", v.Status, "the visitor's draft must not be published")
		}
	}
}

// Security review of #294: with the publish route gated, the reset must not
// publish for the visitor. Deprecating v1 used to make repair publish the
// first draft, whatever a visitor had written into it.
func TestTemplateSeeder_RepairDoesNotPublishAVisitorsDraft(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	f := fixtures.All()[0]
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)

	draft := rewriteDraft(t, s, ctx, conn, f.Name)
	tpl, err := s.st.GetTemplateByName(ctx, f.Name)
	require.NoError(t, err)
	_, err = s.st.SetTemplateVersionStatus(ctx, store.SetTemplateVersionStatusParams{
		ID: tpl.CurrentVersionID, Status: "deprecated",
	})
	require.NoError(t, err)

	require.NoError(t, s.Run(ctx))
	requireCatalogIsTheFixture(t, s, ctx, f, draft)
}

// The same with nothing published left to bring back: the fixture goes in as a
// new published version beside the visitor's draft, which holds the template's
// one draft slot.
func TestTemplateSeeder_RepairWithoutAPublishedVersionUsesTheFixture(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	f := fixtures.All()[0]
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)

	draft := rewriteDraft(t, s, ctx, conn, f.Name)
	tpl, err := s.st.GetTemplateByName(ctx, f.Name)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `UPDATE templates SET current_version_id = NULL WHERE id = $1`, tpl.ID)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `DELETE FROM template_versions WHERE template_id = $1 AND status <> 'draft'`, tpl.ID)
	require.NoError(t, err)

	require.NoError(t, s.Run(ctx))
	requireCatalogIsTheFixture(t, s, ctx, f, draft)
}

// Security review of ef8f935: a version a visitor published before the gate
// existed is published and immutable, but it is not the fixture. If it is
// current and deprecated, the reset must publish the fixture instead of
// bringing the visitor's content back.
func TestTemplateSeeder_RepairDoesNotUndeprecateAVisitorsVersion(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))
	f := fixtures.All()[0]
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)

	tpl, err := s.st.GetTemplateByName(ctx, f.Name)
	require.NoError(t, err)
	visitors := tpl.CurrentVersionID
	_, err = conn.Exec(ctx, `UPDATE template_versions SET resources_yaml = $2, status = 'deprecated' WHERE id = $1`,
		visitors, visitorYAML)
	require.NoError(t, err)

	require.NoError(t, s.Run(ctx))
	requireCatalogIsTheFixture(t, s, ctx, f, store.TemplateVersion{})
	for _, v := range versionsOf(t, s, ctx, f.Name) {
		if v.ID == visitors {
			require.Equal(t, "deprecated", v.Status, "the visitor's version must stay out of the catalog")
		}
	}
}

func TestTemplateSeeder_RefusesAnotherOwnersTemplate(t *testing.T) {
	s, ctx := newTestSeeder(t)
	require.NoError(t, s.Run(ctx))

	// Someone else now holds the fixture name — template names are global, and
	// going around the API must not turn that into a silent edit of their rows.
	other := newDemoUser(t, ctx, s.st, "seed-test-other")
	name := fixtures.All()[0].Name
	tpl, err := s.st.GetTemplateByName(ctx, name)
	require.NoError(t, err)
	conn, err := pgx.Connect(ctx, testDSN())
	require.NoError(t, err)
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, `UPDATE templates SET owner_user_id = $2 WHERE id = $1`, tpl.ID, other.ID)
	require.NoError(t, err)

	err = s.Run(ctx)
	require.ErrorContains(t, err, "belongs to another owner")
	require.ErrorContains(t, err, name)
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
