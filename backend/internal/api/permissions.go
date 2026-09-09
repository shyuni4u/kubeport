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
// and a soft filter (canReadTemplate, used to hide rows the caller may not
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

var (
	denyTeamEditor = &accessDenial{http.StatusForbidden, "rbac-denied", "team editor required"}
	denyTeamMember = &accessDenial{http.StatusForbidden, "rbac-denied", "team membership required"}
	denyGlobalTpl  = &accessDenial{http.StatusForbidden, "rbac-denied", "global template requires kubeport-admin"}
	denyDemoScope  = &accessDenial{http.StatusForbidden, "demo-restricted", "demo accounts can only access demo-owned templates"}
)

// templateOwnership is the subset of a template row the template rules need.
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

// reqCache memoizes the lookups the template rules repeat when a handler
// evaluates many rows in one request. A nil *reqCache is valid and simply
// doesn't cache, so single-row handlers pass nil; ListTemplates creates one so
// the cost is O(distinct teams + distinct owners) instead of O(rows).
type reqCache struct {
	callerDone bool
	caller     store.User
	callerErr  error

	roles  map[pgtype.UUID]string // team id → membership role ("" = not a member)
	owners map[pgtype.UUID]string // user id → email
}

func newReqCache() *reqCache {
	return &reqCache{
		roles:  map[pgtype.UUID]string{},
		owners: map[pgtype.UUID]string{},
	}
}

// caller resolves the users row for the authenticated subject. A caller with
// no row yet (never wrote anything) is reported as ok=false, not an error.
func (h *Handlers) caller(ctx context.Context, rc *reqCache) (store.User, bool, error) {
	if rc != nil && rc.callerDone {
		if rc.callerErr != nil {
			return store.User{}, false, rc.callerErr
		}
		return rc.caller, rc.caller.ID.Valid, nil
	}
	u, _ := auth.UserFrom(ctx)
	row, err := h.deps.Store.GetUserByOidcSubject(ctx, u.Subject)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		err = fmt.Errorf("GetUserByOidcSubject: %w", err)
		if rc != nil {
			rc.callerDone, rc.callerErr = true, err
		}
		return store.User{}, false, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		row = store.User{}
	}
	if rc != nil {
		rc.callerDone, rc.caller = true, row
	}
	return row, row.ID.Valid, nil
}

// teamRole returns the caller's role in the team, or "" when they are not a
// member.
func (h *Handlers) teamRole(ctx context.Context, rc *reqCache, teamID pgtype.UUID) (string, error) {
	if rc != nil {
		if role, ok := rc.roles[teamID]; ok {
			return role, nil
		}
	}
	caller, ok, err := h.caller(ctx, rc)
	if err != nil {
		return "", err
	}
	role := ""
	if ok {
		mem, err := h.deps.Store.GetTeamMembership(ctx, store.GetTeamMembershipParams{
			TeamID: teamID,
			UserID: caller.ID,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf("GetTeamMembership: %w", err)
		}
		if err == nil {
			role = mem.Role
		}
	}
	if rc != nil {
		rc.roles[teamID] = role
	}
	return role, nil
}

func (h *Handlers) ownerEmail(ctx context.Context, rc *reqCache, ownerID pgtype.UUID) (string, error) {
	if rc != nil {
		if email, ok := rc.owners[ownerID]; ok {
			return email, nil
		}
	}
	owner, err := h.deps.Store.GetUserByID(ctx, ownerID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("GetUserByID: %w", err)
	}
	// Ownerless template (seeded/imported): zero value, i.e. not demo-owned.
	email := owner.Email.String
	if rc != nil {
		rc.owners[ownerID] = email
	}
	return email, nil
}

// evaluateTeamRole applies the team rule: kubeport-admin always passes;
// otherwise the caller must be a member, and an editor when requireEditor.
func (h *Handlers) evaluateTeamRole(ctx context.Context, rc *reqCache, teamID pgtype.UUID, requireEditor bool) (*accessDenial, error) {
	u, _ := auth.UserFrom(ctx)
	if isKubeportAdmin(u) {
		return nil, nil
	}
	role, err := h.teamRole(ctx, rc, teamID)
	if err != nil {
		return nil, err
	}
	switch {
	case role == "":
		if requireEditor {
			return denyTeamEditor, nil
		}
		return denyTeamMember, nil
	case requireEditor && role != "editor":
		return denyTeamEditor, nil
	}
	return nil, nil
}

// ensureTeamEditor writes a 403/500 response and returns false unless the
// caller is kubeport-admin or an editor of the given team. System errors
// (DB outage etc.) resolve to 500, not a misleading 403.
func (h *Handlers) ensureTeamEditor(c *gin.Context, teamID pgtype.UUID) bool {
	d, err := h.evaluateTeamRole(c.Request.Context(), nil, teamID, true)
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

// evaluateTemplateAccess applies the template rule:
//   - Global template (owning_team_id null): caller must be kubeport-admin.
//   - Team template: caller must belong to the team — as an editor when
//     requireEditor, as any member (editor or viewer) when reading.
//     kubeport-admin passes either way.
//   - Demo-domain caller with kubeport-admin: the admin short-circuit is
//     scoped to templates owned by another demo-domain user. Demo accounts
//     need admin UX to author their own templates, but must never reach a real
//     operator's global template.
//
// requireEditor is what separates mutation from reading. Reading has to admit
// viewers: `viewer` exists precisely so a team member can look at the team's
// templates without being able to change them (docs/brainstorming-summary.md
// §teams).
func (h *Handlers) evaluateTemplateAccess(ctx context.Context, rc *reqCache, own templateOwnership, requireEditor bool) (*accessDenial, error) {
	u, _ := auth.UserFrom(ctx)

	if isKubeportAdmin(u) {
		if !auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
			return nil, nil
		}
		email, err := h.ownerEmail(ctx, rc, own.OwnerUserID)
		if err != nil {
			return nil, err
		}
		if !auth.IsDemoEmail(email, h.deps.DemoEmailDomain) {
			return denyDemoScope, nil
		}
		return nil, nil
	}

	if !own.OwningTeamID.Valid {
		return denyGlobalTpl, nil
	}
	return h.evaluateTeamRole(ctx, rc, own.OwningTeamID, requireEditor)
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
	d, err := h.evaluateTemplateAccess(c.Request.Context(), nil, ownershipOf(tpl), true)
	if err != nil {
		log.Printf("ensureTemplateEditor: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to authorize template access")
		return store.GetTemplateByNameRow{}, false
	}
	if d != nil {
		if d == denyDemoScope {
			// Keep the pre-existing wording for the mutation path.
			writeError(c, d.status, d.code, "demo accounts can only edit demo-owned templates")
			return store.GetTemplateByNameRow{}, false
		}
		d.write(c)
		return store.GetTemplateByNameRow{}, false
	}
	return tpl, true
}

// canReadTemplate is the soft form of the read rule, for callers that filter
// rows instead of rejecting a request.
func (h *Handlers) canReadTemplate(ctx context.Context, rc *reqCache, own templateOwnership) (bool, error) {
	d, err := h.evaluateTemplateAccess(ctx, rc, own, false)
	if err != nil {
		return false, err
	}
	return d == nil, nil
}
