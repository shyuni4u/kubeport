package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

const pgUniqueViolation = "23505"

type createClusterReq struct {
	Name             string `json:"name"               binding:"required,min=1"`
	DisplayName      string `json:"display_name"`
	APIURL           string `json:"api_url"            binding:"required,url"`
	CABundle         string `json:"ca_bundle"`
	OIDCIssuerURL    string `json:"oidc_issuer_url"    binding:"required,url"`
	DefaultNamespace string `json:"default_namespace"`
}

// clusterSummary is what a non-admin caller sees. It deliberately drops
// api_url, ca_bundle and oidc_issuer_url: those describe how to reach the
// cluster's apiserver, and every authenticated caller — including a demo
// account — could read them off the full record. k8s RBAC is still the real
// authority, so this is defence in depth rather than the only control.
//
// The deploy form and the template editors only ever read name and
// default_namespace off this payload, so narrowing it costs the UI nothing.
type clusterSummary struct {
	ID               pgtype.UUID `json:"id"`
	Name             string      `json:"name"`
	DisplayName      pgtype.Text `json:"display_name"`
	DefaultNamespace pgtype.Text `json:"default_namespace"`
}

func (h *Handlers) ListClusters(c *gin.Context) {
	cs, err := h.deps.Store.ListClusters(c.Request.Context())
	if err != nil {
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if cs == nil {
		cs = []store.Cluster{}
	}

	// Admins keep the full record — that is how a registration is verified
	// after the fact, and there is no cluster-registration screen yet.
	u, _ := auth.UserFrom(c.Request.Context())
	if isKubeportAdmin(u) {
		c.JSON(http.StatusOK, gin.H{"clusters": cs})
		return
	}

	out := make([]clusterSummary, 0, len(cs))
	for _, cl := range cs {
		out = append(out, clusterSummary{
			ID:               cl.ID,
			Name:             cl.Name,
			DisplayName:      cl.DisplayName,
			DefaultNamespace: cl.DefaultNamespace,
		})
	}
	c.JSON(http.StatusOK, gin.H{"clusters": out})
}

func (h *Handlers) CreateCluster(c *gin.Context) {
	var r createClusterReq
	if err := c.ShouldBindJSON(&r); err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", err.Error())
		return
	}
	cl, err := h.deps.Store.InsertCluster(c.Request.Context(), store.InsertClusterParams{
		Name:             r.Name,
		DisplayName:      store.PgText(r.DisplayName),
		ApiUrl:           r.APIURL,
		CaBundle:         store.PgText(r.CABundle),
		OidcIssuerUrl:    r.OIDCIssuerURL,
		DefaultNamespace: store.PgText(r.DefaultNamespace),
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			writeError(c, http.StatusConflict, "conflict", "cluster name already exists")
			return
		}
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	c.JSON(http.StatusCreated, cl)
}
