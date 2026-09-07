package api

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

// ensureTeamEditor writes a 403/500 response and returns false unless the
// caller is kubeport-admin or an editor of the given team. System errors
// (DB outage etc.) resolve to 500, not a misleading 403.
func (h *Handlers) ensureTeamEditor(c *gin.Context, teamID pgtype.UUID) bool {
	ctx := c.Request.Context()
	u, _ := auth.UserFrom(ctx)

	if isKubeportAdmin(u) {
		return true
	}

	caller, err := h.deps.Store.GetUserByOidcSubject(ctx, u.Subject)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusForbidden, "rbac-denied", "team editor required")
			return false
		}
		log.Printf("ensureTeamEditor: GetUserByOidcSubject: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to resolve caller")
		return false
	}
	mem, err := h.deps.Store.GetTeamMembership(ctx, store.GetTeamMembershipParams{
		TeamID: teamID,
		UserID: caller.ID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusForbidden, "rbac-denied", "team editor required")
			return false
		}
		log.Printf("ensureTeamEditor: GetTeamMembership: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to resolve membership")
		return false
	}
	if mem.Role != "editor" {
		writeError(c, http.StatusForbidden, "rbac-denied", "team editor required")
		return false
	}
	return true
}

// ensureTemplateEditor loads the template by name from the URL and writes a
// 403 response if the caller can't mutate it. Returns (template, true) when
// allowed, or (zero, false) when the response has already been written.
//
// Rules:
// - Global template (owning_team_id null): caller must be kubeport-admin.
// - Team template: caller must be a team editor OR kubeport-admin.
// - Demo-domain caller with kubeport-admin: the admin short-circuit is scoped
//   to templates owned by another demo-domain user. Demo accounts need admin
//   UX to author their own templates, but must never be able to edit a real
//   operator's global template.
func (h *Handlers) ensureTemplateEditor(c *gin.Context, name string) (store.GetTemplateByNameRow, bool) {
	ctx := c.Request.Context()
	tpl, err := h.deps.Store.GetTemplateByName(c, name)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template "+name)
		return store.GetTemplateByNameRow{}, false
	}
	u, _ := auth.UserFrom(ctx)

	if isKubeportAdmin(u) {
		if !auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
			return tpl, true
		}
		owner, err := h.deps.Store.GetUserByID(ctx, tpl.OwnerUserID)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				log.Printf("ensureTemplateEditor: GetUserByID: %v", err)
				writeError(c, http.StatusInternalServerError, "internal", "failed to resolve template owner")
				return store.GetTemplateByNameRow{}, false
			}
			// Ownerless template (seeded/imported): not demo-owned.
			owner = store.User{}
		}
		if !auth.IsDemoEmail(owner.Email.String, h.deps.DemoEmailDomain) {
			writeError(c, http.StatusForbidden, "demo-restricted",
				"demo accounts can only edit demo-owned templates")
			return store.GetTemplateByNameRow{}, false
		}
		return tpl, true
	}

	if !tpl.OwningTeamID.Valid {
		writeError(c, http.StatusForbidden, "rbac-denied", "global template requires kubeport-admin")
		return store.GetTemplateByNameRow{}, false
	}

	if !h.ensureTeamEditor(c, tpl.OwningTeamID) {
		return store.GetTemplateByNameRow{}, false
	}
	return tpl, true
}
