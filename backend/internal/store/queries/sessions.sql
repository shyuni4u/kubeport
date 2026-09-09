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
--
-- ORDER BY + FOR UPDATE SKIP LOCKED makes concurrent sweepers actually safe
-- rather than merely idempotent: two replicas take disjoint batches in the
-- same order instead of racing for the same rows, so neither deadlocks and
-- neither comes back short while work remains (which the caller reads as
-- "nothing left" and would otherwise end the pass early).
-- The batch must be a CTE, not an IN (SELECT ... LIMIT). Postgres plans the
-- latter as a semi-join and re-executes the subquery per outer row; with
-- SKIP LOCKED each re-execution returns a *different* row, so the DELETE
-- removes more than batch_size (EXPLAIN shows Nested Loop Semi Join over the
-- Limit node). A CTE carrying a locking clause is never inlined, so it is
-- evaluated exactly once.
-- name: DeleteExpiredSessions :execrows
WITH doomed AS (
  SELECT id FROM sessions
   WHERE expires_at < now()
   ORDER BY expires_at
   LIMIT sqlc.arg('batch_size')
   FOR UPDATE SKIP LOCKED
)
DELETE FROM sessions WHERE id IN (SELECT id FROM doomed);
