package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

// accessDenial is a "the caller may not do this" verdict from one of the
// evaluate* rules below. The rules return it instead of writing a response so
// the same rule can back both a hard gate (ensure*, which writes the response)
// and a soft filter (canEditTemplate, used to hide rows the caller may not
// see). A nil *accessDenial means allowed; a non-nil error means the rule
// could not be evaluated (DB outage etc.) and must surface as 500, never as a
// misleading 403.
type accessDenial struct {
	status int
	code   string
	msg    string
}

func (d *accessDenial) write(c *gin.Context) {
	writeError(c, d.status, d.code, d.msg)
}

var denyTeamEditor = &accessDenial{http.StatusForbidden, "rbac-denied", "team editor required"}

// templateOwnership is the subset of a template row the editor rule needs.
// Both store.GetTemplateByNameRow and store.ListTemplatesRow reduce to it.
type templateOwnership struct {
	OwnerUserID  pgtype.UUID
	OwningTeamID pgtype.UUID
}

func ownershipOf(t store.GetTemplateByNameRow) templateOwnership {
	return templateOwnership{OwnerUserID: t.OwnerUserID, OwningTeamID: t.OwningTeamID}
}

func ownershipOfListRow(t store.ListTemplatesRow) templateOwnership {
	return templateOwnership{OwnerUserID: t.OwnerUserID, OwningTeamID: t.OwningTeamID}
}

// evaluateTeamEditor applies the team rule: kubeport-admin, or an editor of
// the given team.
func (h *Handlers) evaluateTeamEditor(ctx context.Context, teamID pgtype.UUID) (*accessDenial, error) {
	u, _ := auth.UserFrom(ctx)
	if isKubeportAdmin(u) {
		return nil, nil
	}
	caller, err := h.deps.Store.GetUserByOidcSubject(ctx, u.Subject)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return denyTeamEditor, nil
		}
		return nil, fmt.Errorf("GetUserByOidcSubject: %w", err)
	}
	mem, err := h.deps.Store.GetTeamMembership(ctx, store.GetTeamMembershipParams{
		TeamID: teamID,
		UserID: caller.ID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return denyTeamEditor, nil
		}
		return nil, fmt.Errorf("GetTeamMembership: %w", err)
	}
	if mem.Role != "editor" {
		return denyTeamEditor, nil
	}
	return nil, nil
}

// ensureTeamEditor writes a 403/500 response and returns false unless the
// caller is kubeport-admin or an editor of the given team. System errors
// (DB outage etc.) resolve to 500, not a misleading 403.
func (h *Handlers) ensureTeamEditor(c *gin.Context, teamID pgtype.UUID) bool {
	d, err := h.evaluateTeamEditor(c.Request.Context(), teamID)
	if err != nil {
		log.Printf("ensureTeamEditor: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to resolve membership")
		return false
	}
	if d != nil {
		d.write(c)
		return false
	}
	return true
}

// evaluateTemplateEditor applies the template rule:
// - Global template (owning_team_id null): caller must be kubeport-admin.
// - Team template: caller must be a team editor OR kubeport-admin.
// - Demo-domain caller with kubeport-admin: the admin short-circuit is scoped
//   to templates owned by another demo-domain user. Demo accounts need admin
//   UX to author their own templates, but must never be able to touch a real
//   operator's global template.
func (h *Handlers) evaluateTemplateEditor(ctx context.Context, own templateOwnership) (*accessDenial, error) {
	u, _ := auth.UserFrom(ctx)

	if isKubeportAdmin(u) {
		if !auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
			return nil, nil
		}
		owner, err := h.deps.Store.GetUserByID(ctx, own.OwnerUserID)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return nil, fmt.Errorf("GetUserByID: %w", err)
			}
			// Ownerless template (seeded/imported): not demo-owned.
			owner = store.User{}
		}
		if !auth.IsDemoEmail(owner.Email.String, h.deps.DemoEmailDomain) {
			return &accessDenial{http.StatusForbidden, "demo-restricted",
				"demo accounts can only access demo-owned templates"}, nil
		}
		return nil, nil
	}

	if !own.OwningTeamID.Valid {
		return &accessDenial{http.StatusForbidden, "rbac-denied",
			"global template requires kubeport-admin"}, nil
	}
	return h.evaluateTeamEditor(ctx, own.OwningTeamID)
}

// ensureTemplateEditor loads the template by name from the URL and writes a
// 403 response if the caller can't mutate it. Returns (template, true) when
// allowed, or (zero, false) when the response has already been written.
func (h *Handlers) ensureTemplateEditor(c *gin.Context, name string) (store.GetTemplateByNameRow, bool) {
	tpl, err := h.deps.Store.GetTemplateByName(c, name)
	if err != nil {
		writeError(c, http.StatusNotFound, "not-found", "template "+name)
		return store.GetTemplateByNameRow{}, false
	}
	d, err := h.evaluateTemplateEditor(c.Request.Context(), ownershipOf(tpl))
	if err != nil {
		log.Printf("ensureTemplateEditor: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to authorize template access")
		return store.GetTemplateByNameRow{}, false
	}
	if d != nil {
		if d.code == "demo-restricted" {
			// Keep the pre-existing wording for the mutation path.
			d = &accessDenial{d.status, d.code, "demo accounts can only edit demo-owned templates"}
		}
		d.write(c)
		return store.GetTemplateByNameRow{}, false
	}
	return tpl, true
}

// canEditTemplate is the soft form of evaluateTemplateEditor, for callers that
// filter rows instead of rejecting a request.
func (h *Handlers) canEditTemplate(ctx context.Context, own templateOwnership) (bool, error) {
	d, err := h.evaluateTemplateEditor(ctx, own)
	if err != nil {
		return false, err
	}
	return d == nil, nil
}
