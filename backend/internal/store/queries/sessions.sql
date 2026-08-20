-- name: CreateSession :one
INSERT INTO sessions (user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetSession :one
SELECT * FROM sessions WHERE id = $1 AND expires_at > now();

-- name: UpdateSessionTokens :exec
UPDATE sessions
   SET id_token_encrypted = $2, refresh_token_encrypted = $3, id_token_exp = $4
 WHERE id = $1;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE id = $1;
