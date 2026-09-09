package api

import (
	"context"
	"net/http"

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
	StreamLogs(ctx context.Context, namespace string, pods []string) (<-chan k8s.LogLine, <-chan error)
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
}

type Handlers struct {
	deps    Deps
	openapi *openapiProxy
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
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	h := &Handlers{deps: deps, openapi: newOpenAPIProxy(cfg.OpenAPICacheMax)}
	noDemo := denyDemo(deps.DemoEmailDomain)

	// One budget shared by every route that makes kubeport call the target
	// apiserver on the caller's behalf. Gating only the refresh (#97) would
	// have left the reads that actually do the fetching unmetered: a cache
	// miss pulls up to 10MiB, and a caller can manufacture misses at will by
	// varying the group/version.
	upstream := newRateLimiter(60, 4096)
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
	v.POST("/templates", noDemoAuthoring, h.CreateTemplate)
	v.POST("/templates/preview", h.PreviewTemplate)
	v.POST("/templates/:name/render", h.PreviewRender)
	v.GET("/templates/:name", h.GetTemplate)
	v.PATCH("/templates/:name", h.UpdateTemplate)
	v.GET("/templates/:name/versions", h.ListTemplateVersions)
	v.POST("/templates/:name/versions", h.CreateTemplateVersion)
	v.GET("/templates/:name/versions/:v", h.GetTemplateVersion)
	v.PATCH("/templates/:name/versions/:v", h.UpdateTemplateVersion)
	v.DELETE("/templates/:name/versions/:v", h.DeleteTemplateVersion)
	v.POST("/templates/:name/versions/:v/publish", h.PublishVersion)
	v.POST("/templates/:name/versions/:v/deprecate", h.DeprecateVersion)
	v.POST("/templates/:name/versions/:v/undeprecate", h.UndeprecateVersion)
	v.GET("/releases", h.ListReleases)
	v.POST("/releases", h.CreateRelease)
	v.GET("/releases/:id", h.GetRelease)
	v.GET("/releases/:id/logs", h.StreamReleaseLogs)
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
