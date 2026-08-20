package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

// GetMe returns the caller's claims and is the warm-up path that ensures a
// users row exists for subsequent read-only lookups (ListTeams,
// ListTeamMembers, ensureTemplateEditor). We GET-first and only UpsertUser on
// miss or when the cached email/display_name drift from the ID-token claims,
// to keep /v1/me off the write path on the hot call pattern.
func (h *Handlers) GetMe(c *gin.Context) {
	u, ok := auth.UserFrom(c.Request.Context())
	if !ok {
		writeError(c, http.StatusUnauthorized, "unauthenticated", "user not in context")
		return
	}
	existing, err := h.deps.Store.GetUserByOidcSubject(c, u.Subject)
	needWrite := err != nil ||
		existing.Email.String != u.Email ||
		existing.DisplayName.String != u.Name
	if needWrite {
		if _, err := h.deps.Store.UpsertUser(c, store.UpsertUserParams{
			OidcSubject: u.Subject,
			Email:       store.PgText(u.Email),
			DisplayName: store.PgText(u.Name),
		}); err != nil {
			writeError(c, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"subject": u.Subject,
		"email":   u.Email,
		"groups":  u.Groups,
	})
}
