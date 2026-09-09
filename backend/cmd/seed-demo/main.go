package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
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
	reset := flag.Bool("reset", false, "delete demo-owned rows before seeding (DATABASE_URL is required either way)")
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

	// Required for the template half of the seed, not just for -reset:
	// templates are written straight to the database (see templates.go).
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required — the catalog is seeded straight into the database " +
			"(local dev: postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable)")
	}
	demoDomain := getenv("KBP_DEMO_EMAIL_DOMAIN", "demo.kubeport")

	// Everything that can fail runs before anything is destroyed. Reset is a
	// method on the value preflight returns, so it is not reachable until Dex,
	// the API, the database and the demo identity have all answered.
	pf, err := runPreflight(ctx, hc, dsn, demoDomain)
	if err != nil {
		log.Fatalf("preflight: %v — demo data left intact, nothing was deleted", err)
	}
	defer pf.st.Close()

	if *reset {
		if err := pf.reset(ctx, dsn, demoDomain); err != nil {
			log.Fatalf("reset: %v", err)
		}
	}
	if err := (&templateSeeder{st: pf.st, owner: pf.owner}).Run(ctx); err != nil {
		log.Fatalf("seed templates: %v", err)
	}
	if err := pf.seeder.Run(ctx); err != nil {
		log.Fatalf("seed releases: %v", err)
	}
	log.Println("seed-demo: done")
}

// preflight is proof that every failure-prone dependency answered while the
// demo was still intact: Dex issued both tokens, the API accepted them, the
// database opened, and DEMO_ADMIN_EMAIL resolves to the users row the catalog
// is owned by.
//
// It exists because of the ordering bug in #105. resetDB used to run first, so
// a Dex outage, an expired client secret or a stale DEMO_ADMIN_PASSWORD would
// empty the demo and only then fail — leaving it empty until the next run six
// hours later. reset() is a method here rather than a free function so that
// order cannot be reintroduced: you cannot delete anything without first
// holding the evidence that the re-seed has somewhere to come from.
type preflight struct {
	st     *store.Store
	owner  store.User
	seeder *Seeder
}

func runPreflight(ctx context.Context, hc *http.Client, dsn, demoDomain string) (*preflight, error) {
	issuer, cid, csec := must("DEMO_OIDC_ISSUER"), must("DEMO_OIDC_CLIENT_ID"), must("DEMO_OIDC_CLIENT_SECRET")
	adminEmail := must("DEMO_ADMIN_EMAIL")
	// The catalog is global (no owning team); what keeps it out of real users'
	// view and inside resetDB's reach is the demo domain on its owner. Seeding
	// as anyone else would write a permanent global catalog no reset collects.
	// Checked first because it needs no I/O — a misconfigured domain should
	// never get as far as spending a token grant.
	if !auth.IsDemoEmail(adminEmail, demoDomain) {
		return nil, fmt.Errorf("DEMO_ADMIN_EMAIL %s is outside KBP_DEMO_EMAIL_DOMAIN %s — "+
			"the seeded catalog would not be demo-owned", adminEmail, demoDomain)
	}
	adminTok, err := passwordGrant(ctx, hc, issuer, cid, csec, adminEmail, must("DEMO_ADMIN_PASSWORD"))
	if err != nil {
		return nil, fmt.Errorf("admin token: %w", err)
	}
	userTok, err := passwordGrant(ctx, hc, issuer, cid, csec, must("DEMO_USER_EMAIL"), must("DEMO_USER_PASSWORD"))
	if err != nil {
		return nil, fmt.Errorf("user token: %w", err)
	}
	base := must("KBP_API_BASE_URL")
	s := &Seeder{
		admin:   &apiClient{base: base, hc: hc, token: adminTok},
		user:    &apiClient{base: base, hc: hc, token: userTok},
		cluster: getenv("DEMO_CLUSTER", "oci-a1"),
		ns:      getenv("DEMO_NAMESPACE", "demo"),
	}
	// Warm up users rows (GET /v1/me upserts on first sight) so team/ownership
	// lookups work. The template seeder owns the catalog it writes by the
	// demo-admin users row this call creates. It doubles as proof that the API
	// is reachable and accepts these tokens — worth knowing before the wipe.
	for _, c := range []*apiClient{s.admin, s.user} {
		if code, b, err := c.do(ctx, http.MethodGet, "/v1/me", nil); err != nil || code != http.StatusOK {
			return nil, fmt.Errorf("/v1/me: %d %s %v", code, b, err)
		}
	}
	st, err := store.NewStore(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("store: %w", err)
	}
	owner, err := st.GetUserByEmail(ctx, store.PgText(adminEmail))
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("demo admin %s not in users: %w", adminEmail, err)
	}
	return &preflight{st: st, owner: owner, seeder: s}, nil
}

// reset removes everything demo accounts own. k8s objects in the demo
// namespace are wiped by the CronJob's kubectl initContainer, not here.
//
// It hangs off *preflight deliberately — see that type's comment. The receiver
// is unused; it is the compiler-checked evidence that the re-seed's
// dependencies were reachable before this destroyed anything.
func (*preflight) reset(ctx context.Context, dsn, demoDomain string) error {
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
