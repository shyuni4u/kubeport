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

-- Retention: an expired session is already unusable (GetSession filters on
-- expires_at), so the row is nothing but an encrypted id_token and refresh
-- token we no longer need. Sweep them instead of keeping them forever — the
-- s_expires_at index makes this cheap. Deletes in bounded batches so one call
-- can never hold a long lock on a table that logins are writing to.
-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
 WHERE id IN (
   SELECT id FROM sessions WHERE expires_at < now() LIMIT sqlc.arg('batch_size')
 );
