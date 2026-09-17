package api

import (
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"net/http"
)

func (h *Handlers) DeleteTemplate(c *gin.Context) {
	tpl, ok := h.ensureTemplateEditor(c, c.Param("name"))
	if !ok {
		return
	}
	if !isAdmin(c) {
		writeError(c, http.StatusForbidden, "rbac-denied", "template deletion requires kubeport-admin")
		return
	}
	if err := h.deps.Store.DeleteTemplate(c.Request.Context(), tpl.ID); err != nil {
		var pgErr *pgconn.PgError
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			writeError(c, http.StatusNotFound, "not-found", "template")
		case errors.As(err, &pgErr) && pgErr.Code == "23503":
			writeError(c, http.StatusConflict, "conflict", "a release references this template")
		default:
			internalError(c, "delete template", err)
		}
		return
	}
	c.Status(http.StatusNoContent)
}
