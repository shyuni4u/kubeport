-- name: UpsertUser :one
INSERT INTO users (oidc_subject, email, display_name, first_seen_at, last_seen_at)
VALUES ($1, $2, $3, now(), now())
ON CONFLICT (oidc_subject) DO UPDATE
   SET email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       last_seen_at = now()
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: GetUserByOidcSubject :one
SELECT * FROM users WHERE oidc_subject = $1;
