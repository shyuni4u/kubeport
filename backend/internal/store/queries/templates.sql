-- name: ListTemplates :many
SELECT t.id, t.name, t.display_name, t.description, t.tags, t.owner_user_id, t.current_version_id, t.created_at, t.updated_at, t.owning_team_id,
       tv.version    AS current_version,
       tv.ui_spec_yaml AS current_ui_spec,
       tv.status     AS current_status
  FROM templates t
  LEFT JOIN template_versions tv ON tv.id = t.current_version_id
 ORDER BY t.name;

-- name: GetTemplateByName :one
SELECT t.id, t.name, t.display_name, t.description, t.tags,
       t.owner_user_id, t.current_version_id, t.created_at, t.updated_at,
       t.owning_team_id,
       tv.version AS current_version,
       team.name  AS owning_team_name
  FROM templates t
  LEFT JOIN template_versions tv ON tv.id = t.current_version_id
  LEFT JOIN teams team            ON team.id = t.owning_team_id
 WHERE t.name = $1;

-- name: InsertTemplate :one
INSERT INTO templates (name, display_name, description, tags, owner_user_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: UpdateTemplateCurrentVersion :exec
UPDATE templates SET current_version_id = $2, updated_at = now() WHERE id = $1;

-- name: UpdateTemplateMeta :one
UPDATE templates
   SET display_name = COALESCE(sqlc.narg('display_name'), display_name),
       description  = COALESCE(sqlc.narg('description'), description),
       tags         = COALESCE(sqlc.narg('tags'), tags),
       updated_at   = now()
 WHERE name = sqlc.arg('name')
 RETURNING *;

-- name: NextTemplateVersion :one
SELECT COALESCE(MAX(version), 0) + 1 FROM template_versions WHERE template_id = $1;

-- name: InsertTemplateVersion :one
INSERT INTO template_versions (
  template_id, version, resources_yaml, ui_spec_yaml, metadata_yaml, status, notes, created_by_user_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;

-- name: GetTemplateVersion :one
SELECT tv.* FROM template_versions tv
  JOIN templates t ON t.id = tv.template_id
 WHERE t.name = $1 AND tv.version = $2;

-- name: GetTemplateVersionByID :one
SELECT * FROM template_versions WHERE id = $1;

-- name: PublishTemplateVersion :one
UPDATE template_versions
   SET status = 'published', published_at = now()
 WHERE id = $1 AND status = 'draft'
 RETURNING *;

-- name: ListTemplateVersions :many
SELECT tv.* FROM template_versions tv
  JOIN templates t ON t.id = tv.template_id
 WHERE t.name = $1
 ORDER BY tv.version DESC;

-- name: InsertTemplateV2 :one
INSERT INTO templates (name, display_name, description, tags, owner_user_id, owning_team_id)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: InsertTemplateVersionV2 :one
INSERT INTO template_versions (
  template_id, version, resources_yaml, ui_spec_yaml, metadata_yaml,
  status, notes, created_by_user_id, authoring_mode, ui_state_json
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;

-- name: SetTemplateVersionStatus :one
UPDATE template_versions
   SET status = $2, published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN now() ELSE published_at END
 WHERE id = $1
 RETURNING *;

-- Draft-only update. Published/deprecated versions are immutable so we gate on
-- status = 'draft' in the WHERE clause. Callers distinguish "not found" from
-- "not draft" by reading the version first; the UPDATE returns zero rows when
-- the gate fails. Content columns are optional (sqlc.narg) so callers only
-- send what changed. authoring_mode is intentionally not patchable — drafts
-- keep the mode they were created with.
-- name: UpdateDraftTemplateVersion :one
UPDATE template_versions
   SET resources_yaml = COALESCE(sqlc.narg('resources_yaml'), resources_yaml),
       ui_spec_yaml   = COALESCE(sqlc.narg('ui_spec_yaml'),   ui_spec_yaml),
       metadata_yaml  = COALESCE(sqlc.narg('metadata_yaml'),  metadata_yaml),
       notes          = COALESCE(sqlc.narg('notes'),          notes),
       ui_state_json  = COALESCE(sqlc.narg('ui_state_json'),  ui_state_json)
 WHERE id = sqlc.arg('id') AND status = 'draft'
 RETURNING *;

-- Draft-only delete. The releases.template_version_id FK is ON DELETE RESTRICT,
-- so deleting a non-draft version that any release references would fail at
-- the DB level. We gate at the query level as a fast-path + clear error
-- shape: returns zero rows when the version is not draft so the handler can
-- return 409 instead of a generic DB error.
-- name: DeleteDraftTemplateVersion :one
DELETE FROM template_versions
 WHERE id = $1 AND status = 'draft'
 RETURNING id;
