package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"kubeport/internal/config"
	"kubeport/internal/k8s"
	"kubeport/internal/store"
)

// K8sApplier applies, deletes, or inspects resources on a k8s cluster.
type K8sApplier interface {
	ApplyAll(ctx context.Context, ns string, yaml []byte) error
	// Release methods take a k8s.ReleaseRef — name and database id: the name
	// alone is not an identity (#195).
	DeleteByRelease(ctx context.Context, ref k8s.ReleaseRef) error
	ListInstances(ctx context.Context, ref k8s.ReleaseRef) ([]k8s.Instance, error)
	StreamLogs(ctx context.Context, namespace string, pods []string, since time.Time) (<-chan k8s.LogLine, <-chan error)
	// CheckAccess proxies a SelfSubjectAccessReview so the caller can ask
	// "can I do verb on resource?" before attempting an action.
	CheckAccess(ctx context.Context, spec k8s.AccessCheck) (k8s.AccessResult, error)
	// CheckApply reports which objects in a rendered release already belong to
	// another release, or to nothing kubeport created, before anything is
	// applied (#161). creating is false for an update.
	CheckApply(ctx context.Context, ref k8s.ReleaseRef, yaml []byte, creating bool) (k8s.ApplyCheck, error)
	// StampLeftBehind gives a NameOnly release's id to the objects it owns by
	// name alone — including those its next manifest drops, or an earlier
	// update already dropped — before its first update since #195 ends the
	// name-only fallback (see k8s.Client.StampLeftBehind).
	StampLeftBehind(ctx context.Context, ref k8s.ReleaseRef, previous, next []byte) error
	// ReleasePresence reports whether a release's rendered objects are still
	// in the cluster, for a release that has no pods (#33).
	ReleasePresence(ctx context.Context, ref k8s.ReleaseRef, yaml []byte) (k8s.Presence, error)
}

// K8sClientFactory creates per-request k8s clients using the caller's token.
type K8sClientFactory interface {
	NewWithToken(apiURL, caBundle, bearer string) (K8sApplier, error)
}

type Deps struct {
	Verifier        TokenVerifier
	Store           *store.Store
	K8sFactory      K8sClientFactory
	DemoEmailDomain string // "" = no demo restrictions
	// DemoAllowTemplateCreate lets demo accounts author new templates and
	// publish versions. Off by default: demo accounts carry kubeport-admin so
	// they can show the admin UX, and these are the admin powers whose output
	// outlives the visit and reaches other people — a published version runs
	// whatever the visitor wrote against Secrets other visitors deployed
	// (#294). Turn it on only where showing authoring is the point
	// (docs/brainstorming-summary.md §14).
	DemoAllowTemplateCreate bool
	// HealthPublicCatalog lets the unauthenticated /healthz?verbose=1 report
	// the catalog size. Off by default — see config.Config for why, and
	// healthz() for what consumes it.
	HealthPublicCatalog bool
	// Version is the build identifier /healthz reports — the short git sha the
	// image was built from (build-images.yml passes it as VERSION, the same
	// seven characters as the `sha-<7>` image tag). "" reports "dev".
	Version string
}

type Handlers struct {
	deps    Deps
	openapi *openapiProxy
	// streams caps how many log streams a caller holds open at once. The
	// per-minute budget on that route prices opening one and nothing after, so
	// on its own it bounds the rate and not the count (#169).
	streams *streamSlots
	// demoStreams caps, per sign-in, the streams a demo account holds, so one
	// visitor cannot take the pool that account shares with every other (#200).
	demoStreams *streamSlots

	// streamLifetime is how long a log stream stays open before the server
	// ends it and the client reconnects through a fresh authorization (#169).
	streamLifetime time.Duration

	// releaseWrite is the budget for creating, updating and deleting a release
	// (#232), the routes that cost the most per request: a create or update
	// dry-runs and then applies every object the template renders, a delete
	// issues a DeleteCollection per kind, and an update rolls the workload out
	// again. One bucket for the three, so a loop cannot switch verbs for a
	// fresh one, and apart from the read and control-plane budgets, so writes
	// cannot starve a detail page or the deploy form's permission check.
	// 30/min never refuses a person pressing deploy or delete.
	//
	// It is spent inside the handlers, just before the first cluster call,
	// not as route middleware. On the demo every visitor shares one identity —
	// the reset Job's seeder among them — and a bucket drained by requests the
	// handler refuses for free (a body that does not parse, a release that is
	// not yours) would lock all of them out of deploying while costing the
	// caller nothing and sparing the apiserver nothing.
	releaseWrite *rateLimiter
}

func NewRouter(cfg config.Config, deps Deps) *gin.Engine {
	r := gin.New()
	// requestID and accessLog sit outside Recovery so a panicking request still
	// gets an id and a log line — Recovery converts the panic to a 500 within
	// their scope rather than unwinding past them.
	r.Use(requestID(), accessLog(), gin.CustomRecovery(recoveredPanic), limitBodySize(maxRequestBody))
	// Without this, gin answers a wrong verb with its 404, and a caller reading
	// "not found" concludes the resource is gone rather than that it used the
	// wrong method (issue #81).
	r.HandleMethodNotAllowed = true
	r.NoRoute(routeNotFound)
	r.NoMethod(methodNotAllowed)
	r.GET("/healthz", healthz(deps, &catalogGauge{}))

	h := &Handlers{
		deps:           deps,
		openapi:        newOpenAPIProxy(cfg.OpenAPICacheMax),
		streams:        newStreamSlots(cfg.LogStreamsPerCaller),
		demoStreams:    newStreamSlots(demoLogStreamsPerLogin),
		streamLifetime: logStreamLifetime(cfg.LogStreamMaxLifetime),
		releaseWrite:   newRateLimiter(30, 4096),
	}
	noDemo := denyDemo(deps.DemoEmailDomain)

	// One budget shared by the control-plane reads the deploy form and log
	// tab fan out to: SSAR, the cluster OpenAPI reads and opening a log
	// stream. Gating only the refresh (#97) would have left the reads that
	// actually do the fetching unmetered: a cache miss pulls up to 10MiB, and
	// a caller can manufacture misses at will by varying the group/version.
	//
	// Release reads, which also call the apiserver, have a budget of their own
	// below; release writes spend theirs inside the handlers
	// (Handlers.releaseWrite).
	upstream := newRateLimiter(60, 4096)
	// Two buckets for the routes that run SerializeUIMode, split by who fires
	// them rather than by what they compute.
	//
	// Both are separate from `upstream` because this is CPU, not control
	// plane: none of these routes touches the apiserver, and sharing that
	// bucket would let an admin's typing starve the SSAR fan-out the deploy
	// form depends on.
	//
	// They are separate from EACH OTHER because preview fires itself and
	// saving does not. The debounce is 300ms with no maxWait, so preview can
	// reach 3.3/s while a 120/min bucket refills at 2/s — a long editing
	// session drains it. On one shared bucket that lands on the next save as a
	// 429, and the admin loses the draft: strictly worse than the starvation
	// this split was introduced to avoid. Saving is already authorized and
	// already cost-bounded, so it gets its own wallet.
	//
	// Preview's 120/min is sized off what the editor can actually emit: the
	// two panes are sibling <TabsContent> panels with no keepMounted, so only
	// one is ever mounted, and its debounce has no maxWait — it fires after a
	// pause, not during typing. The ceiling is ~200/min and real use is well
	// under it, while the 60/min `upstream` bucket issue #135 asked for could
	// refuse an admin mid-edit.
	//
	// What both bound is the flood. The pod's cpu limit is 500m and the
	// limits in SerializeUIMode hold one call to ~150ms, so preview's 2/s is
	// under half that allowance — bounded and throttled, where an unmetered
	// loop pegs the limit and throttles every other route on the pod.
	preview := newRateLimiter(120, 4096)
	authoring := newRateLimiter(60, 4096)
	// GET /releases/:id lists the release's pods on the target apiserver on
	// every call, so it belongs under a budget like the reads on `upstream`
	// (#212) — but not on that one. It is the route the UI polls: the release
	// list probes one row per release (four at a time) and a settling detail
	// page re-renders on a backoff, each render reading it for the layout and
	// the page. On the demo's shared identity those reads would drain the
	// 60/min bucket the log-stream opens and the deploy form's SSAR fan-out
	// depend on, and a detail page refused with 429 shows an error screen.
	//
	// 240/min is four times that: a polling tab spends a few tokens a minute
	// and a list view one per row, so several visitors fit, while a loop is
	// held to 4 pod LISTs a second per caller.
	releaseRead := newRateLimiter(240, 4096)
	v := r.Group("/v1", requireAuth(deps.Verifier))
	v.GET("/me", h.GetMe)
	v.GET("/clusters", h.ListClusters)
	v.POST("/clusters", requireAdmin(), noDemo, h.CreateCluster)
	v.GET("/clusters/:name/openapi", rateLimit(upstream), h.GetOpenAPIIndex)
	v.GET("/clusters/:name/openapi/*gv", rateLimit(upstream), h.GetOpenAPIGroupVersion)
	// Evicting the cache makes the next read re-fetch the schema from the
	// target apiserver, so this is a load amplifier on the control plane, not
	// a read. Gate it like the other management routes (issue #97).
	v.POST("/clusters/:name/openapi/refresh", requireAdmin(), noDemo, h.RefreshOpenAPI)
	v.POST("/selfsubjectaccessreview", rateLimit(upstream), h.CheckSelfSubjectAccess)
	v.GET("/templates", h.ListTemplates)
	// Authoring is gated for demo accounts unless the deployment opted in;
	// everything else about the admin UX stays available to them.
	noDemoAuthoring := noDemo
	if deps.DemoAllowTemplateCreate {
		noDemoAuthoring = func(c *gin.Context) { c.Next() }
	}
	v.POST("/templates", rateLimit(authoring), noDemoAuthoring, h.CreateTemplate)
	// Deliberately NOT requireAdmin()/noDemoAuthoring, though issue #135 asked
	// for both. Preview returns a pure function of the body the caller just
	// sent — it reads no template, no cluster and no DB, so there is nothing
	// for authorization to protect; what was dangerous was the cost, and that
	// is bounded in SerializeUIMode now. requireAdmin would also be stricter
	// than the save path it previews for: POST /templates admits a team editor
	// who is not kubeport-admin, and gating preview would let them author
	// without seeing what they are authoring. noDemoAuthoring would take the
	// editor walkthrough away from the demo admin, which is the tour.
	v.POST("/templates/preview", rateLimit(preview), h.PreviewTemplate)
	v.POST("/templates/:name/render", h.PreviewRender)
	v.GET("/templates/:name", h.GetTemplate)
	v.PATCH("/templates/:name", h.UpdateTemplate)
	v.GET("/templates/:name/versions", h.ListTemplateVersions)
	v.POST("/templates/:name/versions", rateLimit(authoring), h.CreateTemplateVersion)
	v.GET("/templates/:name/versions/:v", h.GetTemplateVersion)
	v.PATCH("/templates/:name/versions/:v", rateLimit(authoring), h.UpdateTemplateVersion)
	v.DELETE("/templates/:name/versions/:v", h.DeleteTemplateVersion)
	// Publishing is authoring too (#294). Demo accounts are shared and can read
	// pod logs in the demo namespace, so a version a visitor publishes can echo
	// the Secrets other visitors deployed; redacting release reads (#196) does
	// not stop that. Drafts stay open — they cannot be deployed (#252) — so the
	// editor tour is unchanged.
	v.POST("/templates/:name/versions/:v/publish", noDemoAuthoring, h.PublishVersion)
	// Deprecate and undeprecate are the two sides of the same switch and take
	// the same gate. Undeprecating puts a version back — any published version
	// can be deployed — so it is publishing by another name (#306). Deprecating
	// alone would then be a one-way switch in a shared account: one visitor
	// takes a seeded template's current version out and no other visitor can
	// deploy it, or bring it back, until the daily reset.
	v.POST("/templates/:name/versions/:v/deprecate", noDemoAuthoring, h.DeprecateVersion)
	v.POST("/templates/:name/versions/:v/undeprecate", noDemoAuthoring, h.UndeprecateVersion)
	v.GET("/releases", h.ListReleases)
	// Release writes are budgeted inside the handlers — see Handlers.releaseWrite.
	v.POST("/releases", h.CreateRelease)
	v.GET("/releases/:id", rateLimit(releaseRead), h.GetRelease)
	// Opening a stream lists the release's pods and then follows one log per
	// pod, so it is a control-plane fan-out like the two above and belongs on
	// the same budget — it was simply missed when #73 drew the line. #134 made
	// the omission cost more: a refusal now costs a second request, because the
	// client re-asks for the same URL to read the Problem EventSource hid from
	// it. One token per open, not one per line; a follow that stays up for an
	// hour spends nothing after the handshake.
	v.GET("/releases/:id/logs", rateLimit(upstream), h.StreamReleaseLogs)
	v.PUT("/releases/:id", h.UpdateRelease)
	v.DELETE("/releases/:id", h.DeleteRelease)
	v.GET("/teams", h.ListTeams)
	v.POST("/teams", requireAdmin(), noDemo, h.CreateTeam)
	v.GET("/teams/:id/members", h.ListTeamMembers)
	v.POST("/teams/:id/members", requireAdmin(), noDemo, h.AddTeamMember)
	v.DELETE("/teams/:id/members/:user_id", requireAdmin(), noDemo, h.RemoveTeamMember)
	return r
}

// Three responses in the service are produced by no handler at all, and gin's
// defaults for all three sat outside the one Problem shape #79 established for
// /v1 (issue #81). The BFF forwards the upstream content type unchanged, so
// each one reached the client in a shape no client parses.
//
//   - a path matching no route: text/plain "404 page not found"
//   - a wrong verb: folded into that same 404 unless HandleMethodNotAllowed is
//     on, which made an agent conclude the resource was gone
//   - a panic: gin.Recovery() answers AbortWithStatus, an empty body with no
//     content type — and this is the 5xx a client meets most often, because it
//     is the one a handler bug produces
//
// gin still normalises a trailing slash with a 3xx of its own
// (RedirectTrailingSlash, on by default). That one is left alone: it is a
// redirect rather than an error, and turning it into a 404 would break links
// that work today.
//
// None of the three echoes the request path. The caller already knows what it
// asked for, and reflecting a caller-controlled string into a response is the
// same mistake #72 closed in the access log.
func routeNotFound(c *gin.Context) {
	writeError(c, http.StatusNotFound, "not-found", "no route matches this path")
}

func methodNotAllowed(c *gin.Context) {
	// gin has already set Allow from the routes registered on this path, which
	// is the only machine-actionable part of a 405 — it says which verb to
	// retry with.
	writeError(c, http.StatusMethodNotAllowed, "method-not-allowed",
		"this path exists but does not accept this method; see the Allow header")
}

// recoveredPanic answers a panic in the same shape as every other error.
//
// gin.Recovery() calls AbortWithStatus, which writes a bare 500 with no body
// and no content type. A client that had been told "every error is a Problem"
// would parse that as JSON and throw — on the one 5xx it is most likely to
// meet, since a handler bug is what produces it. The stack trace is already on
// its way to the log via CustomRecovery; the id ties the two together.
func recoveredPanic(c *gin.Context, _ any) {
	writeError(c, http.StatusInternalServerError, "internal", "request failed")
}
