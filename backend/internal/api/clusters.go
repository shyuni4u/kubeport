package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

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

// clusterSummary is the only shape GET /v1/clusters returns. It deliberately
// drops api_url, ca_bundle and oidc_issuer_url: those describe how to reach a
// cluster's apiserver, and the list is readable by every authenticated caller.
//
// This is not role-dependent on purpose. Gating the full record behind
// isKubeportAdmin would not have closed the hole the finding was about: when
// demo mode is on, the chart appends demo.adminEmail to KBP_DEV_ADMIN_EMAILS
// (templates/_helpers.tpl "kubeport.devAdminEmails"), so the public demo
// admin *is* in the kubeport-admin group and would still have read the
// production cluster's endpoint. One shape also means a client never has to
// guess why a field is absent.
//
// Nothing reads the dropped fields off this endpoint — the deploy form and
// both template editors use name/default_namespace, POST /v1/releases and the
// SSAR take a cluster name. An admin registering a cluster still gets the full
// record back from POST /v1/clusters.
type clusterSummary struct {
	ID               pgtype.UUID `json:"id"`
	Name             string      `json:"name"`
	DisplayName      pgtype.Text `json:"display_name"`
	DefaultNamespace pgtype.Text `json:"default_namespace"`
}

func (h *Handlers) ListClusters(c *gin.Context) {
	cs, err := h.deps.Store.ListClusters(c.Request.Context())
	if err != nil {
		internalError(c, "ListClusters", err)
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
		internalError(c, "CreateCluster", err)
		return
	}
	c.JSON(http.StatusCreated, cl)
}
