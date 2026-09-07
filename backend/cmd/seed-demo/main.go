package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"kubeport/internal/auth"
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

	demoDomain := getenv("KBP_DEMO_EMAIL_DOMAIN", "demo.kubeport")
	if *reset {
		if err := resetDB(ctx, must("DATABASE_URL"), demoDomain); err != nil {
			log.Fatalf("reset: %v", err)
		}
	}

	issuer, cid, csec := must("DEMO_OIDC_ISSUER"), must("DEMO_OIDC_CLIENT_ID"), must("DEMO_OIDC_CLIENT_SECRET")
	adminTok, err := passwordGrant(ctx, hc, issuer, cid, csec, must("DEMO_ADMIN_EMAIL"), must("DEMO_ADMIN_PASSWORD"))
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
	for _, c := range []*apiClient{s.admin, s.user} {
		if code, b, err := c.do(ctx, http.MethodGet, "/v1/me", nil); err != nil || code != http.StatusOK {
			log.Fatalf("/v1/me: %d %s %v", code, b, err)
		}
	}
	if err := s.Run(ctx); err != nil {
		log.Fatalf("seed: %v", err)
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
	stmts := []string{
		`DELETE FROM releases WHERE created_by_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
		`DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1)))`,
		`DELETE FROM templates WHERE owner_user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
		`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE lower($1))`,
	}
	for _, q := range stmts {
		tag, err := conn.Exec(ctx, q, like)
		if err != nil {
			return err
		}
		log.Printf("reset: %s → %d rows", q[:30], tag.RowsAffected())
	}
	return nil
}
