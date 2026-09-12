package api

import (
	"context"
	"errors"
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

// healthErrTTL keeps a burst from stampeding after a failure without holding a
// stale `degraded` past the blip that caused it.
const healthErrTTL = 3 * time.Second

// healthQueryTimeout bounds the query the cache is filled by. It is not the
// caller's deadline — see count().
const healthQueryTimeout = 3 * time.Second

// errCatalogScopeUnset is what an operator gets for asking an unauthenticated
// endpoint to publish a number it cannot scope to the demo. Reporting the
// whole catalog here would be the exact disclosure HealthPublicCatalog's
// default-off is there to prevent.
var errCatalogScopeUnset = errors.New("catalog reporting needs KBP_DEMO_EMAIL_DOMAIN to scope the count to demo-owned templates")

// catalogGauge counts the catalog for /healthz?verbose=1, at most once per
// healthCacheTTL. The lock is held across the query on purpose: a burst
// collapses into one round trip instead of one per request.
type catalogGauge struct {
	mu      sync.Mutex
	at      time.Time
	catalog demoCatalog
	err     error
}

// demoCatalog is what the gauge caches: both fields come from the same pass
// over the same rows, so they cannot disagree about which templates count.
type demoCatalog struct {
	templates int
	// lastSeed is the oldest created_at among the counted templates, zero when
	// there are none. See demoVisibleTemplates for why oldest.
	lastSeed time.Time
}

// count deliberately takes no caller context. The cached value belongs to the
// process, not to whoever asked for it first: filling it from a request
// context let a caller who hung up poison the cache with context.Canceled for
// the full TTL, and every later caller read `degraded`. That is reachable
// without an attacker — the BFF gives up after five seconds — and it would
// have turned the uptime alarm permanently red, hiding the empty-catalog case
// this whole signal exists to catch.
func (g *catalogGauge) count(st *store.Store, demoDomain string) (demoCatalog, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// A failure is held briefly so a burst still collapses, but not for the
	// full TTL: a transient database blip should not read as degraded for
	// half a minute after it has passed.
	ttl := healthCacheTTL
	if g.err != nil {
		ttl = healthErrTTL
	}
	if !g.at.IsZero() && time.Since(g.at) < ttl {
		return g.catalog, g.err
	}
	ctx, cancel := context.WithTimeout(context.Background(), healthQueryTimeout)
	defer cancel()
	cat, err := demoVisibleTemplates(ctx, st, demoDomain)
	g.at, g.catalog, g.err = time.Now(), cat, err
	return g.catalog, err
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
//
// The same rows also date the seed (#148). Since #140 a reset whose preflight
// fails deletes nothing, so a skipped cycle leaves the count exactly as green
// as a successful one. A cycle that does run deletes every demo-owned template
// and the seeder recreates them, so the oldest demo-owned published row is
// when the catalog was last seeded. Oldest rather than newest: a template
// published after the seed — a demo visitor's, where authoring is opted in —
// would otherwise make a catalog that has not been re-seeded in days look
// fresh. The error it can make is the safe one: seed-demo's reset keeps a demo
// template whose version a non-demo release still references (#306). last_seed
// then stays old even though the Job succeeded — a state someone has to clear
// by hand anyway, by deleting that release.
func demoVisibleTemplates(ctx context.Context, st *store.Store, demoDomain string) (demoCatalog, error) {
	// Without a demo domain there is no "demo-owned" to filter on, and the
	// count would be the size of the operator's own catalog. The chart happens
	// to prevent this by nesting the env inside demo.enabled, but that is the
	// chart's accident, not this endpoint's contract: a compose file or a
	// `kubectl set env` reaches it directly.
	if demoDomain == "" {
		return demoCatalog{}, errCatalogScopeUnset
	}
	rows, err := st.ListTemplates(ctx)
	if err != nil {
		return demoCatalog{}, err
	}
	isDemoOwner := map[[16]byte]bool{}
	var cat demoCatalog
	for _, row := range rows {
		if !row.CurrentVersionID.Valid || row.CurrentStatus.String != "published" {
			continue
		}
		key := row.OwnerUserID.Bytes
		demo, seen := isDemoOwner[key]
		if !seen {
			owner, err := st.GetUserByID(ctx, row.OwnerUserID)
			if err != nil {
				return demoCatalog{}, err
			}
			demo = auth.IsDemoEmail(owner.Email.String, demoDomain)
			isDemoOwner[key] = demo
		}
		if !demo {
			continue
		}
		cat.templates++
		if row.CreatedAt.Valid && (cat.lastSeed.IsZero() || row.CreatedAt.Time.Before(cat.lastSeed)) {
			cat.lastSeed = row.CreatedAt.Time
		}
	}
	return cat, nil
}

// healthz answers the kubelet probes on the bare path with a constant — they
// run every 10 and 20 seconds and must not touch the database.
//
// ?verbose=1 adds the catalog size, but only where HealthPublicCatalog says
// so. The endpoint is unauthenticated, so a self-hosted install must not leak
// its catalog's size to anyone who asks; the public demo opts in.
//
// The count is the signal #119 asked for: a seed that fails after the reset
// has wiped leaves an empty catalog that nothing notices until the next
// scheduled reset — the last occurrence (#104) was found only because a
// browser review happened to run just after a reset. Publishing the count lets
// the existing uptime ping (.github/workflows/uptime-ping.yml) assert it is
// non-zero, which makes an already-scheduled 10-minute cron the alert channel
// with no new infrastructure.
//
// `last_seed` is the other half (#148). Since the reset checks its
// dependencies before deleting anything (#140), a cycle that cannot run is
// skipped rather than emptying the demo — so the count stays green, and only
// the seed's age shows that the daily reset has not happened.
//
// It stays 200 even when the count is unavailable: the same path backs the
// readiness probe, and failing it over a reporting problem would take the pod
// out of service. Callers branch on the body, not the status.
//
// `version` is on every response, bare path included. It is what lets anyone
// outside the cluster answer "which commit is live" without shell access to
// the node — the deploy workflow polls it to confirm a rollout landed, and
// before it existed sessions had to ask each other. It is a constant, so the
// probes still touch nothing, and the repository is public, so the sha
// discloses nothing a visitor could not already read.
func healthz(deps Deps, gauge *catalogGauge) gin.HandlerFunc {
	version := deps.Version
	if version == "" {
		version = "dev"
	}
	return func(c *gin.Context) {
		if c.Query("verbose") != "1" {
			c.JSON(http.StatusOK, gin.H{"status": "ok", "version": version})
			return
		}
		body := gin.H{"status": "ok", "version": version}
		if deps.HealthPublicCatalog && deps.Store != nil {
			cat, err := gauge.count(deps.Store, deps.DemoEmailDomain)
			switch {
			case errors.Is(err, errCatalogScopeUnset):
				// A misconfiguration, not an outage: say nothing publicly and
				// leave the operator a line saying why the flag does nothing.
				logWithheld(c, "healthz: catalog reporting disabled", err)
			case err != nil:
				// Withheld for the same reason every other 5xx detail is: this
				// endpoint is unauthenticated, and the error carries the DSN's
				// host and the driver's internals.
				logWithheld(c, "healthz: count templates", err)
				body["status"] = "degraded"
				body["catalog"] = gin.H{"available": false}
			default:
				catalog := gin.H{"available": true, "templates": cat.templates}
				// Whole seconds in UTC: the consumer is a shell cron doing
				// `date -d`, and sub-second precision says nothing about a
				// daily job.
				if !cat.lastSeed.IsZero() {
					catalog["last_seed"] = cat.lastSeed.UTC().Truncate(time.Second).Format(time.RFC3339)
				}
				body["catalog"] = catalog
			}
		}
		c.JSON(http.StatusOK, body)
	}
}
