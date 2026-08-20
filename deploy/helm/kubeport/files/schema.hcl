schema "public" {}

table "users" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "oidc_subject" {
    type = text
    null = false
  }
  column "email" {
    type = text
    null = true
  }
  column "display_name" {
    type = text
    null = true
  }
  column "first_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "last_seen_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  index "users_oidc_sub" {
    columns = [column.oidc_subject]
    unique  = true
  }
}

table "clusters" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "name" {
    type = text
    null = false
  }
  column "display_name" {
    type = text
    null = true
  }
  column "api_url" {
    type = text
    null = false
  }
  column "ca_bundle" {
    type = text
    null = true
  }
  column "oidc_issuer_url" {
    type = text
    null = false
  }
  column "default_namespace" {
    type = text
    null = true
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "updated_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  index "clusters_name_uq" {
    columns = [column.name]
    unique  = true
  }
}

table "templates" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "name" {
    type = text
    null = false
  }
  column "display_name" {
    type = text
    null = false
  }
  column "description" {
    type = text
    null = true
  }
  column "tags" {
    type = sql("text[]")
    null = true
  }
  column "owner_user_id" {
    type = uuid
    null = false
  }
  column "current_version_id" {
    type = uuid
    null = true
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "updated_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "owning_team_id" {
    type = uuid
    null = true
  }
  primary_key {
    columns = [column.id]
  }
  index "templates_name_uq" {
    columns = [column.name]
    unique  = true
  }
  foreign_key "t_owner_fk" {
    columns     = [column.owner_user_id]
    ref_columns = [table.users.column.id]
    on_delete   = RESTRICT
  }
  foreign_key "t_current_version_fk" {
    columns     = [column.current_version_id]
    ref_columns = [table.template_versions.column.id]
    on_delete   = SET_NULL
    on_update   = NO_ACTION
  }
  foreign_key "t_team_fk" {
    columns     = [column.owning_team_id]
    ref_columns = [table.teams.column.id]
    on_delete   = SET_NULL
  }
}

table "template_versions" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "template_id" {
    type = uuid
    null = false
  }
  column "version" {
    type = integer
    null = false
  }
  column "resources_yaml" {
    type = text
    null = false
  }
  column "ui_spec_yaml" {
    type = text
    null = false
  }
  column "metadata_yaml" {
    type = text
    null = true
  }
  column "status" {
    type = text
    null = false
  }
  column "notes" {
    type = text
    null = true
  }
  column "created_by_user_id" {
    type = uuid
    null = false
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "published_at" {
    type = timestamptz
    null = true
  }
  column "authoring_mode" {
    type    = text
    null    = false
    default = "yaml"
  }
  column "ui_state_json" {
    type = jsonb
    null = true
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "tv_template_fk" {
    columns     = [column.template_id]
    ref_columns = [table.templates.column.id]
    on_delete   = CASCADE
  }
  index "tv_unique_version" {
    columns = [column.template_id, column.version]
    unique  = true
  }
  index "tv_draft_unique" {
    columns = [column.template_id]
    unique  = true
    where   = "status = 'draft'"
  }
}

table "releases" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "name" {
    type = text
    null = false
  }
  column "template_version_id" {
    type = uuid
    null = false
  }
  column "cluster_id" {
    type = uuid
    null = false
  }
  column "namespace" {
    type = text
    null = false
  }
  column "values_json" {
    type = jsonb
    null = false
  }
  column "rendered_yaml" {
    type = text
    null = false
  }
  column "created_by_user_id" {
    type = uuid
    null = false
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "updated_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "r_tv_fk" {
    columns     = [column.template_version_id]
    ref_columns = [table.template_versions.column.id]
    on_delete   = RESTRICT
  }
  foreign_key "r_cluster_fk" {
    columns     = [column.cluster_id]
    ref_columns = [table.clusters.column.id]
    on_delete   = RESTRICT
  }
  foreign_key "r_owner_fk" {
    columns     = [column.created_by_user_id]
    ref_columns = [table.users.column.id]
    on_delete   = RESTRICT
  }
  index "r_name_uq" {
    columns = [column.cluster_id, column.namespace, column.name]
    unique  = true
  }
  index "r_owner" {
    columns = [column.created_by_user_id]
  }
}

table "sessions" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "user_id" {
    type = uuid
    null = false
  }
  column "id_token_encrypted" {
    type = text
    null = false
  }
  column "refresh_token_encrypted" {
    type = text
    null = true
  }
  column "id_token_exp" {
    type = timestamptz
    null = false
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  column "expires_at" {
    type = timestamptz
    null = false
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "s_user_fk" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = CASCADE
  }
  index "s_expires_at" {
    columns = [column.expires_at]
  }
}

table "teams" {
  schema = schema.public
  column "id" {
    type    = uuid
    null    = false
    default = sql("gen_random_uuid()")
  }
  column "name" {
    type = text
    null = false
  }
  column "display_name" {
    type = text
    null = true
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
  index "teams_name_uq" {
    columns = [column.name]
    unique  = true
  }
}

table "team_memberships" {
  schema = schema.public
  column "user_id" {
    type = uuid
    null = false
  }
  column "team_id" {
    type = uuid
    null = false
  }
  column "role" {
    type = text
    null = false
  }
  column "created_at" {
    type    = timestamptz
    null    = false
    default = sql("now()")
  }
  primary_key {
    columns = [column.user_id, column.team_id]
  }
  foreign_key "tm_user_fk" {
    columns     = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete   = CASCADE
  }
  foreign_key "tm_team_fk" {
    columns     = [column.team_id]
    ref_columns = [table.teams.column.id]
    on_delete   = CASCADE
  }
  index "tm_team" {
    columns = [column.team_id]
  }
}
