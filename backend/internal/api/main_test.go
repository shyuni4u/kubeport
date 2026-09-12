package api_test

import (
	"context"
	"log"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// TestMain runs the api-package integration tests and then deletes the rows
// they created. Without this, every test run leaves dozens of
// clusters/templates/teams in the shared dev database — the UI editor then
// picks `clusters[0]` and ends up pointing at a stale `cluster-*` row that
// no longer exists in any real cluster, which surfaces as "schema loading…"
// forever.
//
// We identify test-created rows by name suffix. `randSuffix()` uses
// `time.Now().Format("150405.000000")` (HHMMSS.micros), and every helper
// bakes that suffix into the entity's `name`. Real user-created rows (the
// `kind` cluster, the `web` template, the `guest` team) have no numeric
// suffix, so they're preserved.
//
// If TEST_DATABASE_URL isn't reachable we skip cleanup entirely — tests
// that need the DB will fail on their own; we shouldn't block the test
// binary over a cleanup best-effort.
func TestMain(m *testing.M) {
	code := m.Run()
	cleanupTestFixtures()
	os.Exit(code)
}

func cleanupTestFixtures() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testDatabaseURL())
	if err != nil {
		log.Printf("cleanupTestFixtures: connect skipped: %v", err)
		return
	}
	defer conn.Close(ctx)

	// HHMMSS.micros → -NNNNNN.NNNNNN at the end of a name. We anchor with $
	// so a template named "web-staging" or a cluster named "prod-us-east-1"
	// is safe. Users creating names that end in this exact pattern would
	// collide, but that's vanishingly unlikely.
	const suffixPattern = `-[0-9]{6}\.[0-9]{6}$`

	// Order matters because of FKs: releases → (clusters, template_versions);
	// template_versions → templates; team_memberships → (teams, users).
	// Deleting in this order lets the FK cascades / RESTRICTs hold without
	// blowing up, and we skip rows that don't match the suffix pattern so
	// user-created state survives.
	ops := []struct {
		name  string
		query string
	}{
		{"releases by cluster", `DELETE FROM releases WHERE cluster_id IN (SELECT id FROM clusters WHERE name ~ $1)`},
		{"releases by template_version", `DELETE FROM releases WHERE template_version_id IN (
			SELECT tv.id FROM template_versions tv JOIN templates t ON t.id = tv.template_id WHERE t.name ~ $1)`},
		{"template_versions by template", `DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE name ~ $1)`},
		{"templates", `DELETE FROM templates WHERE name ~ $1`},
		{"clusters", `DELETE FROM clusters WHERE name ~ $1`},
		{"team_memberships via teams", `DELETE FROM team_memberships WHERE team_id IN (SELECT id FROM teams WHERE name ~ $1)`},
		{"teams", `DELETE FROM teams WHERE name ~ $1`},
		// Users are keyed by oidc subject; test helpers create users via
		// `customVerifier{Subject: "alice-" + suffix}` etc., so the suffix
		// lives on oidc_subject, not name.
		{"users by oidc_subject", `DELETE FROM users WHERE oidc_subject ~ $1`},
	}
	for _, op := range ops {
		tag, err := conn.Exec(ctx, op.query, suffixPattern)
		if err != nil {
			log.Printf("cleanupTestFixtures: %s: %v", op.name, err)
			continue
		}
		if tag.RowsAffected() > 0 {
			log.Printf("cleanupTestFixtures: %s deleted %d", op.name, tag.RowsAffected())
		}
	}
}
