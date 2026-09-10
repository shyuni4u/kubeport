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
	DeleteByRelease(ctx context.Context, namespace, release string) error
	ListInstances(ctx context.Context, namespace, release string) ([]k8s.Instance, error)
	StreamLogs(ctx context.Context, namespace string, pods []string, since time.Time) (<-chan k8s.LogLine, <-chan error)
	// CheckAccess proxies a SelfSubjectAccessReview so the caller can ask
	// "can I do verb on resource?" before attempting an action.
	CheckAccess(ctx context.Context, spec k8s.AccessCheck) (k8s.AccessResult, error)
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
	// DemoAllowTemplateCreate lets demo accounts author new templates. Off by
	// default: demo accounts carry kubeport-admin so they can show the admin
	// UX, and template creation is the one admin power whose output outlives
	// the visit and reaches other people. Turn it on only where showing
	// authoring is the point (docs/brainstorming-summary.md §14).
	DemoAllowTemplateCreate bool
	// HealthPublicCatalog lets the unauthenticated /healthz?verbose=1 report
	// the catalog size. Off by default — see config.Config for why, and
	// healthz() for what consumes it.
	HealthPublicCatalog bool
}

type Handlers struct {
	deps    Deps
	openapi *openapiProxy
	// streams caps how many log streams a caller holds open at once. The
	// per-minute budget on that route prices opening one and nothing after, so
	// on its own it bounds the rate and not the count (#169).
	streams *streamSlots

	// streamLifetime is how long a log stream stays open before the server
	// ends it and the client reconnects through a fresh authorization (#169).
	streamLifetime time.Duration
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
		streamLifetime: logStreamLifetime(cfg.LogStreamMaxLifetime),
	}
	noDemo := denyDemo(deps.DemoEmailDomain)

	// One budget shared by every route that makes kubeport call the target
	// apiserver on the caller's behalf. Gating only the refresh (#97) would
	// have left the reads that actually do the fetching unmetered: a cache
	// miss pulls up to 10MiB, and a caller can manufacture misses at will by
	// varying the group/version.
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
	v.POST("/templates/:name/versions/:v/publish", h.PublishVersion)
	v.POST("/templates/:name/versions/:v/deprecate", h.DeprecateVersion)
	v.POST("/templates/:name/versions/:v/undeprecate", h.UndeprecateVersion)
	v.GET("/releases", h.ListReleases)
	v.POST("/releases", h.CreateRelease)
	v.GET("/releases/:id", h.GetRelease)
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
