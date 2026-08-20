package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"

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

func (h *Handlers) ListClusters(c *gin.Context) {
	cs, err := h.deps.Store.ListClusters(c.Request.Context())
	if err != nil {
		writeError(c, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if cs == nil {
		cs = []store.Cluster{}
	}
	c.JSON(http.StatusOK, gin.H{"clusters": cs})
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
