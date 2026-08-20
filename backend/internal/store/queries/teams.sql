-- name: InsertTeam :one
INSERT INTO teams (name, display_name)
VALUES ($1, $2)
RETURNING *;

-- name: ListTeams :many
SELECT * FROM teams ORDER BY name;

-- name: ListTeamsForUser :many
SELECT t.* FROM teams t
  JOIN team_memberships m ON m.team_id = t.id
 WHERE m.user_id = $1
 ORDER BY t.name;

-- name: GetTeamByID :one
SELECT * FROM teams WHERE id = $1;

-- name: GetTeamByName :one
SELECT * FROM teams WHERE name = $1;

-- name: DeleteTeam :exec
DELETE FROM teams WHERE id = $1;

-- name: InsertTeamMembership :one
INSERT INTO team_memberships (user_id, team_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role
RETURNING *;

-- name: ListTeamMembers :many
SELECT tm.*, u.email, u.display_name AS user_display_name
  FROM team_memberships tm
  JOIN users u ON u.id = tm.user_id
 WHERE tm.team_id = $1
 ORDER BY u.email;

-- name: DeleteTeamMembership :exec
DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2;

-- name: GetTeamMembership :one
SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2;

-- name: CountTemplatesForTeam :one
SELECT COUNT(*) FROM templates WHERE owning_team_id = $1;
