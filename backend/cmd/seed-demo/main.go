package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

func must(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	reset := flag.Bool("reset", false, "delete demo-owned rows before seeding (requires DATABASE_URL)")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	hc := http.DefaultClient
	if ca := os.Getenv("OIDC_CA_FILE"); ca != "" {
		c, err := auth.HTTPClientFromCAFilePublic(ca)
		if err != nil {
			log.Fatal(err)
		}
		hc = c
	}

	// DATABASE_URL is required for the template half of the seed, not just for
	// -reset: templates are written straight to the database (see templates.go).
	dsn := must("DATABASE_URL")
	demoDomain := getenv("KBP_DEMO_EMAIL_DOMAIN", "demo.kubeport")
	if *reset {
		if err := resetDB(ctx, dsn, demoDomain); err != nil {
			log.Fatalf("reset: %v", err)
		}
	}

	issuer, cid, csec := must("DEMO_OIDC_ISSUER"), must("DEMO_OIDC_CLIENT_ID"), must("DEMO_OIDC_CLIENT_SECRET")
	adminEmail := must("DEMO_ADMIN_EMAIL")
	adminTok, err := passwordGrant(ctx, hc, issuer, cid, csec, adminEmail, must("DEMO_ADMIN_PASSWORD"))
	if err != nil {
		log.Fatalf("admin token: %v", err)
	}
	userTok, err := passwordGrant(ctx, hc, issuer, cid, csec, must("DEMO_USER_EMAIL"), must("DEMO_USER_PASSWORD"))
	if err != nil {
		log.Fatalf("user token: %v", err)
	}
	base := must("KBP_API_BASE_URL")
	s := &Seeder{
		admin:   &apiClient{base: base, hc: hc, token: adminTok},
		user:    &apiClient{base: base, hc: hc, token: userTok},
		cluster: getenv("DEMO_CLUSTER", "oci-a1"),
		ns:      getenv("DEMO_NAMESPACE", "demo"),
	}
	// Warm up users rows (GET /v1/me upserts on first sight) so team/ownership lookups work.
	// The template seeder below also depends on this: it owns the catalog it
	// writes by the demo-admin users row this call creates.
	for _, c := range []*apiClient{s.admin, s.user} {
		if code, b, err := c.do(ctx, http.MethodGet, "/v1/me", nil); err != nil || code != http.StatusOK {
			log.Fatalf("/v1/me: %d %s %v", code, b, err)
		}
	}

	st, err := store.NewStore(ctx, dsn)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()
	owner, err := st.GetUserByEmail(ctx, store.PgText(adminEmail))
	if err != nil {
		log.Fatalf("demo admin %s not in users: %v", adminEmail, err)
	}
	if err := (&templateSeeder{st: st, owner: owner}).Run(ctx); err != nil {
		log.Fatalf("seed templates: %v", err)
	}
	if err := s.Run(ctx); err != nil {
		log.Fatalf("seed releases: %v", err)
	}
	log.Println("seed-demo: done")
}

// resetDB removes everything demo accounts own. k8s objects in the demo
// namespace are wiped by the CronJob's kubectl initContainer, not here.
func resetDB(ctx context.Context, dsn, demoDomain string) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	like := "%@" + demoDomain
	stmts := []struct {
		what string
		sql  string
		// tolerateFK: a foreign-key violation means something outside the demo
		// still references this row (e.g. a real user deployed a release from a
		// demo template). Losing that reference would be worse than skipping
		// the delete, and the seeder 409-skips the surviving template anyway.
		tolerateFK bool
	}{
		{"releases", `DELETE FROM releases WHERE created_by_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`, false},
		{"template_versions", `DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1)))`, true},
		{"templates", `DELETE FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`, true},
		{"sessions", `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`, false},
	}
	for _, st := range stmts {
		tag, err := conn.Exec(ctx, st.sql, like)
		if err != nil {
			var pgErr *pgconn.PgError
			if st.tolerateFK && errors.As(err, &pgErr) && pgErr.Code == "23503" {
				log.Printf("WARN: reset: %s skipped \u2014 referenced by non-demo releases: %v", st.what, err)
				continue
			}
			return err
		}
		log.Printf("reset: %s → %d rows", st.what, tag.RowsAffected())
	}
	return nil
}
