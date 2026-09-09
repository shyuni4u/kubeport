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
	r.Use(gin.Recovery(), requestID(), accessLog())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

	h := &Handlers{deps: deps, openapi: newOpenAPIProxy(cfg.OpenAPICacheMax)}
	noDemo := denyDemo(deps.DemoEmailDomain)
	v := r.Group("/v1", requireAuth(deps.Verifier))
	v.GET("/me", h.GetMe)
	v.GET("/clusters", h.ListClusters)
	v.POST("/clusters", requireAdmin(), noDemo, h.CreateCluster)
	v.GET("/clusters/:name/openapi", h.GetOpenAPIIndex)
	v.GET("/clusters/:name/openapi/*gv", h.GetOpenAPIGroupVersion)
	// Evicting the cache makes the next read re-fetch the schema from the
	// target apiserver, so this is a load amplifier on the control plane, not
	// a read. Gate it like the other management routes (issue #97).
	v.POST("/clusters/:name/openapi/refresh", requireAdmin(), noDemo, h.RefreshOpenAPI)
	// One deploy-form page view fans out to several SSARs against the real
	// apiserver, and nothing else bounds how often a caller can make kubeport
	// talk to the control plane. The burst is sized so a single page load is
	// never refused (issue #73).
	v.POST("/selfsubjectaccessreview", rateLimit(newRateLimiter(60, 4096)), h.CheckSelfSubjectAccess)
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
