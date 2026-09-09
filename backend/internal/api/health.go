package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

// healthCacheTTL keeps an unauthenticated endpoint from becoming a database
// amplifier. The consumer is a 10-minute cron, so staleness costs nothing.
const healthCacheTTL = 30 * time.Second

// catalogGauge counts the catalog for /healthz?verbose=1, at most once per
// healthCacheTTL. The lock is held across the query on purpose: a burst
// collapses into one round trip instead of one per request.
type catalogGauge struct {
	mu        sync.Mutex
	at        time.Time
	templates int
	err       error
}

func (g *catalogGauge) count(ctx context.Context, st *store.Store, demoDomain string) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.at.IsZero() && time.Since(g.at) < healthCacheTTL {
		return g.templates, g.err
	}
	n, err := demoVisibleTemplates(ctx, st, demoDomain)
	g.at, g.templates, g.err = time.Now(), n, err
	return g.templates, err
}

// demoVisibleTemplates counts what a demo visitor can actually deploy, which
// is narrower than "rows in the templates table" in two ways that both matter
// here.
//
// Published: a template whose current version is a draft or deprecated shows
// nothing in the catalog, and the seeder's repair() exists precisely because
// that state has happened.
//
// Demo-owned: scopeTemplatesToDemo hides non-demo templates from demo
// visitors, so counting every row would let an operator's own templates mask a
// reset that wiped the demo catalog and failed to re-seed — the monitor would
// report healthy while visitors saw an empty catalog. That is the exact
// failure this signal exists to catch.
func demoVisibleTemplates(ctx context.Context, st *store.Store, demoDomain string) (int, error) {
	rows, err := st.ListTemplates(ctx)
	if err != nil {
		return 0, err
	}
	isDemoOwner := map[[16]byte]bool{}
	n := 0
	for _, row := range rows {
		if !row.CurrentVersionID.Valid || row.CurrentStatus.String != "published" {
			continue
		}
		if demoDomain == "" {
			n++
			continue
		}
		key := row.OwnerUserID.Bytes
		demo, seen := isDemoOwner[key]
		if !seen {
			owner, err := st.GetUserByID(ctx, row.OwnerUserID)
			if err != nil {
				return 0, err
			}
			demo = auth.IsDemoEmail(owner.Email.String, demoDomain)
			isDemoOwner[key] = demo
		}
		if demo {
			n++
		}
	}
	return n, nil
}

// healthz answers the kubelet probes on the bare path with a constant — they
// run every 10 and 20 seconds and must not touch the database.
//
// ?verbose=1 adds the catalog size, but only where HealthPublicCatalog says
// so. The endpoint is unauthenticated, so a self-hosted install must not leak
// its catalog's size to anyone who asks; the public demo opts in.
//
// The count is the signal #119 asked for: the
// demo reset CronJob wipes first and re-seeds second, so a failed seed leaves
// an empty catalog that nothing notices for up to six hours — the last
// occurrence (#104) was found only because a browser review happened to run
// just after a reset. Publishing the count lets the existing uptime ping
// (.github/workflows/uptime-ping.yml) assert it is non-zero, which makes an
// already-scheduled 10-minute cron the alert channel with no new infrastructure.
//
// It stays 200 even when the count is unavailable: the same path backs the
// readiness probe, and failing it over a reporting problem would take the pod
// out of service. Callers branch on the body, not the status.
func healthz(deps Deps, gauge *catalogGauge) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Query("verbose") != "1" {
			c.JSON(http.StatusOK, gin.H{"status": "ok"})
			return
		}
		body := gin.H{"status": "ok"}
		if deps.HealthPublicCatalog && deps.Store != nil {
			n, err := gauge.count(c.Request.Context(), deps.Store, deps.DemoEmailDomain)
			if err != nil {
				// Withheld for the same reason every other 5xx detail is: this
				// endpoint is unauthenticated, and the error carries the DSN's
				// host and the driver's internals.
				logWithheld(c, "healthz: count templates", err)
				body["status"] = "degraded"
				body["catalog"] = gin.H{"available": false}
			} else {
				body["catalog"] = gin.H{"available": true, "templates": n}
			}
		}
		c.JSON(http.StatusOK, body)
	}
}
