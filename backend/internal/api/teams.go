package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/auth"
	"kubeport/internal/store"
)

const pgForeignKeyViolation = "23503"

type createTeamReq struct {
	Name        string `json:"name" binding:"required,min=1"`
	DisplayName string `json:"display_name"`
}

func (h *Handlers) CreateTeam(c *gin.Context) {
	var r createTeamReq
	if !bindJSON(c, &r) {
		return
	}
	team, err := h.deps.Store.InsertTeam(c, store.InsertTeamParams{
		Name:        r.Name,
		DisplayName: store.PgText(r.DisplayName),
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
			writeError(c, http.StatusConflict, "conflict", "team name already exists")
			return
		}
		log.Printf("CreateTeam: %v", err)
		writeError(c, http.StatusInternalServerError, "internal", "failed to create team")
		return
	}
	c.JSON(http.StatusCreated, team)
}

func (h *Handlers) ListTeams(c *gin.Context) {
	u, _ := auth.UserFrom(c.Request.Context())
	demo := auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain)

	if isKubeportAdmin(u) && !demo {
		all, err := h.deps.Store.ListTeams(c)
		if err != nil {
			internalError(c, "ListTeams", err)
			return
		}
		if all == nil {
			all = []store.Team{}
		}
		c.JSON(http.StatusOK, gin.H{"teams": all})
		return
	}

	user, err := h.deps.Store.GetUserByOidcSubject(c, u.Subject)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			internalError(c, "ListTeams: caller", err)
			return
		}
		// User hasn't warmed up via /v1/me yet — show empty teams.
		c.JSON(http.StatusOK, gin.H{"teams": []any{}})
		return
	}
	mine, err := h.deps.Store.ListTeamsForUser(c, user.ID)
	if err != nil {
		internalError(c, "ListTeamsForUser", err)
		return
	}
	if mine == nil {
		mine = []store.Team{}
	}
	if demo {
		visible := make([]store.Team, 0, len(mine))
		for _, team := range mine {
			_, allowed, err := h.demoTeamMembers(c.Request.Context(), team.ID, user.ID)
			if err != nil {
				internalError(c, "ListTeams: demo scope", err)
				return
			}
			if allowed {
				visible = append(visible, team)
			}
		}
		mine = visible
	}
	c.JSON(http.StatusOK, gin.H{"teams": mine})
}

// Teams have no demo ownership marker. Only expose teams the demo caller
// belongs to whose entire membership is demo-only. Use the same snapshot for
// authorization and the response so a mixed team's real members never leak.
func (h *Handlers) demoTeamMembers(ctx context.Context, teamID, callerID pgtype.UUID) ([]store.ListTeamMembersRow, bool, error) {
	members, err := h.deps.Store.ListTeamMembers(ctx, teamID)
	if err != nil {
		return nil, false, err
	}
	belongs := false
	for _, member := range members {
		if !auth.IsDemoEmail(member.Email.String, h.deps.DemoEmailDomain) {
			return nil, false, nil
		}
		if member.UserID == callerID {
			belongs = true
		}
	}
	return members, belongs, nil
}

// isKubeportAdmin centralises the group check used from multiple handlers.
func isKubeportAdmin(u auth.RequestUser) bool {
	for _, g := range u.Groups {
		if g == "kubeport-admin" {
			return true
		}
	}
	return false
}

// parseUUIDParam extracts and parses a UUID from the path parameter.
func parseUUIDParam(c *gin.Context, paramName string) (pgtype.UUID, bool) {
	paramStr := c.Param(paramName)
	u, err := uuid.Parse(paramStr)
	if err != nil {
		writeError(c, http.StatusBadRequest, "validation-error", fmt.Sprintf("invalid %s", paramName))
		return pgtype.UUID{}, false
	}
	return pgtype.UUID{Bytes: u, Valid: true}, true
}

type addMemberReq struct {
	Email string `json:"email" binding:"required,email"`
	Role  string `json:"role"  binding:"required,oneof=editor viewer"`
}

func (h *Handlers) ListTeamMembers(c *gin.Context) {
	tid, ok := parseUUIDParam(c, "id")
	if !ok {
		return
	}
	u, _ := auth.UserFrom(c.Request.Context())
	if auth.IsDemoEmail(u.Email, h.deps.DemoEmailDomain) {
		caller, err := h.deps.Store.GetUserByOidcSubject(c, u.Subject)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			internalError(c, "ListTeamMembers: caller", err)
			return
		}
		var members []store.ListTeamMembersRow
		allowed := false
		if err == nil {
			members, allowed, err = h.demoTeamMembers(c.Request.Context(), tid, caller.ID)
			if err != nil {
				internalError(c, "ListTeamMembers: demo scope", err)
				return
			}
		}
		if !allowed {
			writeError(c, http.StatusNotFound, "not-found", "team not found")
			return
		}
		c.JSON(http.StatusOK, gin.H{"members": members})
		return
	}

	// Admin can list any team. Non-admins must be members of the target team.
	if !isKubeportAdmin(u) {
		// We deliberately do not upsert here — read paths must stay off the
		// write path (see PR #11 review). Instead we differentiate the two
		// 403 causes: user-not-yet-warm vs. genuine non-member, so an API
		// caller can tell which fix they need.
		caller, err := h.deps.Store.GetUserByOidcSubject(c, u.Subject)
		if err != nil {
			writeError(c, http.StatusForbidden, "rbac-denied",
				"user not registered yet; call GET /v1/me first, then retry")
			return
		}
		if _, err := h.deps.Store.GetTeamMembership(c, store.GetTeamMembershipParams{
			TeamID: tid,
			UserID: caller.ID,
		}); err != nil {
			writeError(c, http.StatusForbidden, "rbac-denied", "team member or kubeport-admin required")
			return
		}
	}

	members, err := h.deps.Store.ListTeamMembers(c, tid)
	if err != nil {
		internalError(c, "ListTeamMembers", err)
		return
	}
	if members == nil {
		members = []store.ListTeamMembersRow{}
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

func (h *Handlers) AddTeamMember(c *gin.Context) {
	tid, ok := parseUUIDParam(c, "id")
	if !ok {
		return
	}
	var r addMemberReq
	if !bindJSON(c, &r) {
		return
	}
	// A well-formed id of no team used to reach the insert, trip the
	// membership foreign key and answer 500 (#370).
	if _, err := h.deps.Store.GetTeamByID(c, tid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(c, http.StatusNotFound, "not-found", "team not found")
			return
		}
		internalError(c, "AddTeamMember", err)
		return
	}
	target, err := h.deps.Store.GetUserByEmail(c, store.PgText(r.Email))
	if err != nil {
		writeError(c, http.StatusNotFound, "user-not-found",
			"user must have logged in at least once before being added to a team")
		return
	}
	m, err := h.deps.Store.InsertTeamMembership(c, store.InsertTeamMembershipParams{
		UserID: target.ID,
		TeamID: tid,
		Role:   r.Role,
	})
	if err != nil {
		// The team or the user was deleted between its lookup and this insert.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == pgForeignKeyViolation {
			if pgErr.ConstraintName == "tm_team_fk" {
				writeError(c, http.StatusNotFound, "not-found", "team not found")
			} else {
				writeError(c, http.StatusNotFound, "user-not-found",
					"user must have logged in at least once before being added to a team")
			}
			return
		}
		internalError(c, "AddTeamMember", err)
		return
	}
	c.JSON(http.StatusCreated, m)
}

func (h *Handlers) RemoveTeamMember(c *gin.Context) {
	tid, ok := parseUUIDParam(c, "id")
	if !ok {
		return
	}
	uid, ok := parseUUIDParam(c, "user_id")
	if !ok {
		return
	}
	if err := h.deps.Store.DeleteTeamMembership(c, store.DeleteTeamMembershipParams{TeamID: tid, UserID: uid}); err != nil {
		internalError(c, "RemoveTeamMember", err)
		return
	}
	c.Status(http.StatusNoContent)
}
