-- name: ListReleasesForUser :many
SELECT r.id, r.name, r.template_version_id, r.cluster_id, r.namespace,
       r.created_by_user_id, r.created_at, r.updated_at,
       c.name AS cluster_name, t.name AS template_name, tv.version AS template_version
  FROM releases r
  JOIN clusters c          ON c.id = r.cluster_id
  JOIN template_versions tv ON tv.id = r.template_version_id
  JOIN templates t         ON t.id = tv.template_id
 WHERE r.created_by_user_id = $1
 ORDER BY r.created_at DESC
 LIMIT $2 OFFSET $3;

-- name: ListAllReleases :many
SELECT r.id, r.name, r.template_version_id, r.cluster_id, r.namespace,
       r.created_by_user_id, r.created_at, r.updated_at,
       c.name AS cluster_name, t.name AS template_name, tv.version AS template_version
  FROM releases r
  JOIN clusters c          ON c.id = r.cluster_id
  JOIN template_versions tv ON tv.id = r.template_version_id
  JOIN templates t         ON t.id = tv.template_id
 ORDER BY r.created_at DESC
 LIMIT $1 OFFSET $2;

-- name: ListReleasesForDemoDomain :many
-- Releases created by any user whose email is in the demo domain ($1, e.g.
-- "demo.kubeport"). Backs the scoped admin view for demo accounts: a demo
-- admin sees the demo user's releases but nothing from real users.
SELECT r.id, r.name, r.template_version_id, r.cluster_id, r.namespace,
       r.created_by_user_id, r.created_at, r.updated_at,
       c.name AS cluster_name, t.name AS template_name, tv.version AS template_version
  FROM releases r
  JOIN clusters c          ON c.id = r.cluster_id
  JOIN template_versions tv ON tv.id = r.template_version_id
  JOIN templates t         ON t.id = tv.template_id
  JOIN users u             ON u.id = r.created_by_user_id
 WHERE u.email ILIKE '%@' || sqlc.arg(domain)::text
 ORDER BY r.created_at DESC
 LIMIT sqlc.arg(lim)::int OFFSET sqlc.arg(off)::int;

-- name: GetReleaseByID :one
SELECT r.*, c.name AS cluster_name, c.api_url AS cluster_api_url, c.ca_bundle AS cluster_ca_bundle,
       t.name AS template_name, tv.version AS template_version, tv.ui_spec_yaml
  FROM releases r
  JOIN clusters c          ON c.id = r.cluster_id
  JOIN template_versions tv ON tv.id = r.template_version_id
  JOIN templates t         ON t.id = tv.template_id
 WHERE r.id = $1;

-- name: InsertRelease :one
INSERT INTO releases (name, template_version_id, cluster_id, namespace, values_json, rendered_yaml, created_by_user_id)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: UpdateReleaseValuesAndVersion :exec
UPDATE releases
   SET template_version_id = $2,
       values_json = $3,
       rendered_yaml = $4,
       updated_at = NOW()
 WHERE id = $1;

-- name: DeleteRelease :exec
DELETE FROM releases WHERE id = $1;
