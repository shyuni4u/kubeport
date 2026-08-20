-- Add new schema named "public"
CREATE SCHEMA IF NOT EXISTS "public";
-- Set comment to schema: "public"
COMMENT ON SCHEMA "public" IS 'standard public schema';
-- Create "clusters" table
CREATE TABLE "public"."clusters" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "display_name" text NULL,
  "api_url" text NOT NULL,
  "ca_bundle" text NULL,
  "oidc_issuer_url" text NOT NULL,
  "default_namespace" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "clusters_name_uq" to table: "clusters"
CREATE UNIQUE INDEX "clusters_name_uq" ON "public"."clusters" ("name");
-- Create "releases" table
CREATE TABLE "public"."releases" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "template_version_id" uuid NOT NULL,
  "cluster_id" uuid NOT NULL,
  "namespace" text NOT NULL,
  "values_json" jsonb NOT NULL,
  "rendered_yaml" text NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "r_name_uq" to table: "releases"
CREATE UNIQUE INDEX "r_name_uq" ON "public"."releases" ("cluster_id", "namespace", "name");
-- Create index "r_owner" to table: "releases"
CREATE INDEX "r_owner" ON "public"."releases" ("created_by_user_id");
-- Create "sessions" table
CREATE TABLE "public"."sessions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "id_token_encrypted" text NOT NULL,
  "refresh_token_encrypted" text NULL,
  "id_token_exp" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "s_expires_at" to table: "sessions"
CREATE INDEX "s_expires_at" ON "public"."sessions" ("expires_at");
-- Create "team_memberships" table
CREATE TABLE "public"."team_memberships" (
  "user_id" uuid NOT NULL,
  "team_id" uuid NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "team_id")
);
-- Create index "tm_team" to table: "team_memberships"
CREATE INDEX "tm_team" ON "public"."team_memberships" ("team_id");
-- Create "teams" table
CREATE TABLE "public"."teams" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "display_name" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "teams_name_uq" to table: "teams"
CREATE UNIQUE INDEX "teams_name_uq" ON "public"."teams" ("name");
-- Create "template_versions" table
CREATE TABLE "public"."template_versions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "template_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "resources_yaml" text NOT NULL,
  "ui_spec_yaml" text NOT NULL,
  "metadata_yaml" text NULL,
  "status" text NOT NULL,
  "notes" text NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz NULL,
  "authoring_mode" text NOT NULL DEFAULT 'yaml',
  "ui_state_json" jsonb NULL,
  PRIMARY KEY ("id")
);
-- Create index "tv_draft_unique" to table: "template_versions"
CREATE UNIQUE INDEX "tv_draft_unique" ON "public"."template_versions" ("template_id") WHERE (status = 'draft'::text);
-- Create index "tv_unique_version" to table: "template_versions"
CREATE UNIQUE INDEX "tv_unique_version" ON "public"."template_versions" ("template_id", "version");
-- Create "templates" table
CREATE TABLE "public"."templates" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  "tags" text[] NULL,
  "owner_user_id" uuid NOT NULL,
  "current_version_id" uuid NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "owning_team_id" uuid NULL,
  PRIMARY KEY ("id")
);
-- Create index "templates_name_uq" to table: "templates"
CREATE UNIQUE INDEX "templates_name_uq" ON "public"."templates" ("name");
-- Create "users" table
CREATE TABLE "public"."users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "oidc_subject" text NOT NULL,
  "email" text NULL,
  "display_name" text NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "users_oidc_sub" to table: "users"
CREATE UNIQUE INDEX "users_oidc_sub" ON "public"."users" ("oidc_subject");
-- Modify "releases" table
ALTER TABLE "public"."releases" ADD CONSTRAINT "r_cluster_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT, ADD CONSTRAINT "r_owner_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT, ADD CONSTRAINT "r_tv_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."template_versions" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
-- Modify "sessions" table
ALTER TABLE "public"."sessions" ADD CONSTRAINT "s_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
-- Modify "team_memberships" table
ALTER TABLE "public"."team_memberships" ADD CONSTRAINT "tm_team_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams" ("id") ON UPDATE NO ACTION ON DELETE CASCADE, ADD CONSTRAINT "tm_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
-- Modify "template_versions" table
ALTER TABLE "public"."template_versions" ADD CONSTRAINT "tv_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
-- Modify "templates" table
ALTER TABLE "public"."templates" ADD CONSTRAINT "t_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."template_versions" ("id") ON UPDATE NO ACTION ON DELETE SET NULL, ADD CONSTRAINT "t_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT, ADD CONSTRAINT "t_team_fk" FOREIGN KEY ("owning_team_id") REFERENCES "public"."teams" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
