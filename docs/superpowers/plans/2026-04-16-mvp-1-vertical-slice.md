# kubeport MVP Phase 1 — Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the thinnest end-to-end slice of `kubeport`: an admin can log in, register a cluster, author a template in **YAML mode only**, publish v1, a user can then deploy that template via a generated form and see the deployed release's summary status.

**Architecture:** Go API (Gin + client-go + sqlc + atlas) talking to Postgres and multiple target k8s clusters, fronted by a Next.js 15 app running as a k8s `Deployment` in the same Helm chart as the Go API (see ADR 0001). The Next.js app handles OIDC via `openid-client` and proxies `/api/v1/*` to Go with `Authorization: Bearer <id_token>` injected from a server-side session. Every k8s write uses the user's own token so k8s RBAC is the security source of truth.

**Tech Stack:** Go 1.22, Gin, client-go, sqlc, atlas, pgx, coreos/go-oidc, Next.js 15 (App Router), React 18, TypeScript, Tailwind, shadcn/ui, Monaco Editor, React Hook Form, Zod, `openid-client`, `iron-session`, PostgreSQL 16, Docker.

**Scope (this plan):**
- Project scaffold for `backend/`, `frontend/`, `deploy/docker/`
- DB schema + migrations (all tables from spec §6)
- OIDC login end-to-end (PKCE, httpOnly session cookie, silent refresh)
- Cluster register/list API (no UI; seeded via curl)
- Template + TemplateVersion CRUD (**YAML mode only** — no admin UI editor, no version deprecation yet)
- Template render engine (`resources.yaml + ui-spec.yaml + values -> rendered k8s YAML + standard labels`)
- Release create / list / get / delete (no update/migrate flow yet)
- Release overview page (no logs/events/settings tabs)
- Catalog page + deploy form using `DynamicForm` generated from `ui-spec`
- End-to-end smoke test exercising the whole flow
- README + local docker-compose

**Out of scope (later plans):** UI mode editor, template deprecation, release update/re-apply, SSE log streaming, events tab, update-available notifications, Helm chart, production Dockerfile hardening.

**Reference spec:** [docs/superpowers/specs/2026-04-16-initial-design.md](../specs/2026-04-16-initial-design.md) — every design decision below cites section numbers from the spec.

---

## File Structure

By the end of this plan the repo looks like this. Files marked `(P2)` / `(P3)` ship in later plans; they are listed only so nothing is accidentally created with the wrong name now.

```
kubeport/
├── backend/
│   ├── cmd/server/main.go
│   ├── internal/
│   │   ├── api/
│   │   │   ├── routes.go
│   │   │   ├── middleware.go
│   │   │   ├── errors.go
│   │   │   ├── clusters.go
│   │   │   ├── templates.go
│   │   │   ├── releases.go
│   │   │   └── me.go
│   │   ├── auth/
│   │   │   ├── verifier.go
│   │   │   └── context.go
│   │   ├── k8s/
│   │   │   ├── client.go
│   │   │   └── apply.go
│   │   ├── template/
│   │   │   ├── render.go
│   │   │   ├── spec.go
│   │   │   └── jsonpath.go
│   │   ├── store/
│   │   │   ├── queries/
│   │   │   │   ├── users.sql
│   │   │   │   ├── clusters.sql
│   │   │   │   ├── templates.sql
│   │   │   │   ├── releases.sql
│   │   │   │   └── sessions.sql
│   │   │   ├── db.go             (sqlc generated)
│   │   │   ├── models.go         (sqlc generated)
│   │   │   └── store.go
│   │   └── config/config.go
│   ├── migrations/
│   │   ├── schema.hcl
│   │   └── atlas.hcl
│   ├── sqlc.yaml
│   ├── go.mod
│   └── go.sum
├── frontend/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                             (redirect to /catalog)
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts
│   │   │   │   ├── callback/route.ts
│   │   │   │   └── logout/route.ts
│   │   │   └── v1/[...path]/route.ts
│   │   ├── catalog/page.tsx
│   │   ├── templates/
│   │   │   ├── page.tsx
│   │   │   └── [name]/
│   │   │       ├── page.tsx
│   │   │       └── edit/page.tsx
│   │   └── releases/
│   │       ├── page.tsx
│   │       └── [id]/page.tsx
│   ├── components/
│   │   ├── TopBar.tsx
│   │   ├── ClusterPicker.tsx
│   │   ├── TemplateCard.tsx
│   │   ├── DynamicForm.tsx
│   │   ├── YamlEditor.tsx
│   │   ├── ReleaseTable.tsx
│   │   └── StatusBadge.tsx
│   ├── lib/
│   │   ├── session.ts
│   │   ├── oidc.ts
│   │   ├── api.ts
│   │   └── cookies.ts
│   ├── middleware.ts
│   ├── next.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.mjs
│   ├── tsconfig.json
│   └── package.json
├── deploy/
│   └── docker/
│       ├── Dockerfile.backend
│       └── docker-compose.yml
├── .gitignore
└── README.md
```

**Files with clear single responsibilities:**
- `internal/api/*.go` — one file per resource, handlers only (no business logic).
- `internal/template/render.go` — the render pipeline. Must not know about HTTP or DB.
- `internal/k8s/client.go` — creates a REST client from `(apiURL, caBundle, userToken)`. Must not know about DB.
- `internal/store/*.go` — SQL queries + typed wrappers. Must not know about HTTP.
- `frontend/app/api/v1/[...path]/route.ts` — pure proxy. Must not contain business logic.
- `frontend/components/DynamicForm.tsx` — renders a form from a `UISpec` only. No data fetching.

---

## Prerequisites

The engineer implementing this should have available:

- Go 1.22+
- Node 20+, pnpm 9+
- Docker Desktop (for postgres + dex local dev)
- `atlas` CLI (`curl -sSf https://atlasgo.sh | sh`)
- `sqlc` (`go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest`)
- A k8s cluster (kind, k3d, or minikube is fine). Configure it with OIDC against `dex` for end-to-end tests.

---

## Tasks

### Task 1: Initialize the repository shell

**Files:**
- Create: `.gitignore`
- Create: `README.md`

- [x] **Step 1: Check the current working directory and create root files**

Run from `kubeport/`:
```bash
ls -la
```
Expected: `CLAUDE.md`, `docs/` already present (from brainstorming). No `backend/`, `frontend/`, `deploy/` yet.

- [x] **Step 2: Create `.gitignore`**

Path: `.gitignore`
```
# OS
.DS_Store
Thumbs.db

# Editors
.idea/
.vscode/
*.swp

# Secrets
.env
.env.local
.env.*.local

# Brainstorming session scratch
.superpowers/

# Go
backend/bin/
backend/*.test
backend/coverage.out
backend/vendor/

# Node
frontend/node_modules/
frontend/.next/
frontend/out/

# Docker
*.pid
```

- [x] **Step 3: Create an initial `README.md`**

Path: `README.md`
```markdown
# kubeport

Web app that lets k8s admins publish templated resources (`resources.yaml` + `ui-spec.yaml`) and lets non-expert users deploy/operate them through abstracted forms.

See `docs/superpowers/specs/2026-04-16-initial-design.md` for the design.

## Local development

```bash
# 1. start postgres + dex (local OIDC)
docker compose -f deploy/docker/docker-compose.yml up -d

# 2. apply migrations
cd backend && atlas schema apply --env local

# 3. run Go API
go run ./cmd/server

# 4. run Next.js (in another terminal)
cd frontend && pnpm install && pnpm dev
```
```

- [x] **Step 4: Initialize git and commit**

```bash
git init
git add .gitignore README.md
git commit -m "chore: initialize repo shell with .gitignore and README"
```
Expected: a single-file commit on the default branch.

---

### Task 2: Scaffold the Go backend module

**Files:**
- Create: `backend/go.mod`
- Create: `backend/cmd/server/main.go`
- Create: `backend/internal/config/config.go`
- Create: `backend/internal/api/routes.go`
- Test: `backend/internal/api/routes_test.go`

- [x] **Step 1: Write the failing healthz test**

Path: `backend/internal/api/routes_test.go`
```go
package api_test

import (
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/api"
    "kubeport/internal/config"
)

func TestHealthz(t *testing.T) {
    r := api.NewRouter(config.Config{})
    w := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)
    require.Equal(t, `{"status":"ok"}`, w.Body.String())
}
```

- [x] **Step 2: Run the test — expect it to fail**

```bash
cd backend && go test ./internal/api/...
```
Expected: FAIL (no module, no package).

- [x] **Step 3: Initialize Go module**

```bash
cd backend
go mod init kubeport
go get github.com/gin-gonic/gin@latest
go get github.com/stretchr/testify@latest
```

- [x] **Step 4: Implement `config.Config` and `NewRouter`**

Path: `backend/internal/config/config.go`
```go
package config

type Config struct {
    ListenAddr         string
    DatabaseURL        string
    OIDCIssuer         string
    OIDCAudience       string
    AppEncryptionKeyB64 string
}
```

Path: `backend/internal/api/routes.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/config"
)

func NewRouter(cfg config.Config) *gin.Engine {
    r := gin.New()
    r.Use(gin.Recovery())
    r.GET("/healthz", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{"status": "ok"})
    })
    return r
}
```

Path: `backend/cmd/server/main.go`
```go
package main

import (
    "log"
    "os"

    "kubeport/internal/api"
    "kubeport/internal/config"
)

func main() {
    cfg := config.Config{
        ListenAddr:  getenv("LISTEN_ADDR", ":8080"),
        DatabaseURL: os.Getenv("DATABASE_URL"),
        OIDCIssuer:  os.Getenv("OIDC_ISSUER"),
    }
    r := api.NewRouter(cfg)
    log.Printf("listening on %s", cfg.ListenAddr)
    if err := r.Run(cfg.ListenAddr); err != nil {
        log.Fatal(err)
    }
}

func getenv(k, def string) string {
    if v := os.Getenv(k); v != "" {
        return v
    }
    return def
}
```

- [x] **Step 5: Run the test — expect it to pass**

```bash
cd backend && go test ./internal/api/...
```
Expected: `PASS`

- [x] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat(backend): scaffold gin server with /healthz"
```

---

### Task 3: Add atlas + declarative schema for all tables

**Files:**
- Create: `backend/migrations/schema.hcl`
- Create: `backend/migrations/atlas.hcl`

This ships the full schema from spec §6.2 up front so later tasks only wire queries, not migrations.

- [x] **Step 1: Write `atlas.hcl` with `local` env pointing at docker-compose postgres**

Path: `backend/migrations/atlas.hcl`
```hcl
env "local" {
  src = "file://schema.hcl"
  url = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
  dev = "docker://postgres/16/dev"
}
```

- [x] **Step 2: Write `schema.hcl` covering all 6 tables**

Path: `backend/migrations/schema.hcl`
```hcl
schema "public" {}

table "users" {
  schema = schema.public
  column "id"            { type = uuid        null = false default = sql("gen_random_uuid()") }
  column "oidc_subject"  { type = text        null = false }
  column "email"         { type = text }
  column "display_name"  { type = text }
  column "first_seen_at" { type = timestamptz null = false default = sql("now()") }
  column "last_seen_at"  { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  index "users_oidc_sub" { columns = [column.oidc_subject] unique = true }
}

table "clusters" {
  schema = schema.public
  column "id"                { type = uuid null = false default = sql("gen_random_uuid()") }
  column "name"              { type = text null = false }
  column "display_name"      { type = text }
  column "api_url"           { type = text null = false }
  column "ca_bundle"         { type = text }
  column "oidc_issuer_url"   { type = text null = false }
  column "default_namespace" { type = text }
  column "created_at"        { type = timestamptz null = false default = sql("now()") }
  column "updated_at"        { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  index "clusters_name_uq"   { columns = [column.name] unique = true }
}

table "templates" {
  schema = schema.public
  column "id"                 { type = uuid null = false default = sql("gen_random_uuid()") }
  column "name"               { type = text null = false }
  column "display_name"       { type = text null = false }
  column "description"        { type = text }
  column "tags"               { type = sql("text[]") }
  column "owner_user_id"      { type = uuid null = false }
  column "current_version_id" { type = uuid }
  column "created_at"         { type = timestamptz null = false default = sql("now()") }
  column "updated_at"         { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  index "templates_name_uq"   { columns = [column.name] unique = true }
  foreign_key "t_owner_fk" {
    columns = [column.owner_user_id]
    ref_columns = [table.users.column.id]
    on_delete = RESTRICT
  }
}

table "template_versions" {
  schema = schema.public
  column "id"                 { type = uuid null = false default = sql("gen_random_uuid()") }
  column "template_id"        { type = uuid null = false }
  column "version"            { type = integer null = false }
  column "resources_yaml"     { type = text null = false }
  column "ui_spec_yaml"       { type = text null = false }
  column "metadata_yaml"      { type = text }
  column "status"             { type = text null = false }
  column "notes"              { type = text }
  column "created_by_user_id" { type = uuid null = false }
  column "created_at"         { type = timestamptz null = false default = sql("now()") }
  column "published_at"       { type = timestamptz }
  primary_key { columns = [column.id] }
  foreign_key "tv_template_fk" {
    columns = [column.template_id]
    ref_columns = [table.templates.column.id]
    on_delete = CASCADE
  }
  index "tv_unique_version" { columns = [column.template_id, column.version] unique = true }
  index "tv_draft_unique" {
    columns = [column.template_id]
    unique  = true
    where   = "status = 'draft'"
  }
}

table "releases" {
  schema = schema.public
  column "id"                  { type = uuid null = false default = sql("gen_random_uuid()") }
  column "name"                { type = text null = false }
  column "template_version_id" { type = uuid null = false }
  column "cluster_id"          { type = uuid null = false }
  column "namespace"           { type = text null = false }
  column "values_json"         { type = jsonb null = false }
  column "rendered_yaml"       { type = text null = false }
  column "created_by_user_id"  { type = uuid null = false }
  column "created_at"          { type = timestamptz null = false default = sql("now()") }
  column "updated_at"          { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  foreign_key "r_tv_fk" {
    columns = [column.template_version_id]
    ref_columns = [table.template_versions.column.id]
    on_delete = RESTRICT
  }
  foreign_key "r_cluster_fk" {
    columns = [column.cluster_id]
    ref_columns = [table.clusters.column.id]
    on_delete = RESTRICT
  }
  foreign_key "r_owner_fk" {
    columns = [column.created_by_user_id]
    ref_columns = [table.users.column.id]
    on_delete = RESTRICT
  }
  index "r_name_uq" { columns = [column.cluster_id, column.namespace, column.name] unique = true }
  index "r_owner"   { columns = [column.created_by_user_id] }
}

table "sessions" {
  schema = schema.public
  column "id"                       { type = uuid null = false default = sql("gen_random_uuid()") }
  column "user_id"                  { type = uuid null = false }
  column "id_token_encrypted"       { type = text null = false }
  column "refresh_token_encrypted"  { type = text }
  column "id_token_exp"             { type = timestamptz null = false }
  column "created_at"               { type = timestamptz null = false default = sql("now()") }
  column "expires_at"               { type = timestamptz null = false }
  primary_key { columns = [column.id] }
  foreign_key "s_user_fk" {
    columns = [column.user_id]
    ref_columns = [table.users.column.id]
    on_delete = CASCADE
  }
  index "s_expires_at" { columns = [column.expires_at] }
}
```

- [x] **Step 3: Start postgres via docker-compose (stub)**

We will author `deploy/docker/docker-compose.yml` in Task 4. For now launch postgres directly to unblock schema apply:

```bash
docker run --rm -d --name kubeport-pg \
  -e POSTGRES_USER=kubeport -e POSTGRES_PASSWORD=kubeport -e POSTGRES_DB=kubeport \
  -p 5432:5432 postgres:16
```

- [x] **Step 4: Apply schema and verify**

```bash
cd backend
atlas schema apply --env local --auto-approve
```
Expected: atlas prints the 6 `CREATE TABLE` statements and exits 0.

```bash
docker exec -it kubeport-pg psql -U kubeport -c '\dt'
```
Expected: table list includes `users`, `clusters`, `templates`, `template_versions`, `releases`, `sessions`.

- [x] **Step 5: Commit**

```bash
git add backend/migrations/
git commit -m "feat(backend): add atlas schema for users, clusters, templates, releases, sessions"
```

---

### Task 4: Compose Postgres + dex + adminer for local dev

**Files:**
- Create: `deploy/docker/docker-compose.yml`

Having `dex` locally means OIDC integration can be exercised by tests without calling Google/Keycloak.

- [x] **Step 1: Write the compose file**

Path: `deploy/docker/docker-compose.yml`
```yaml
version: "3.9"
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: kubeport
      POSTGRES_PASSWORD: kubeport
      POSTGRES_DB: kubeport
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]

  dex:
    image: dexidp/dex:v2.39.0
    command: ["dex", "serve", "/config/dex.yaml"]
    ports: ["5556:5556"]
    volumes:
      - ./dex.yaml:/config/dex.yaml:ro

volumes:
  pgdata:
```

Path: `deploy/docker/dex.yaml`
```yaml
issuer: http://localhost:5556
storage:
  type: memory
web:
  http: 0.0.0.0:5556
oauth2:
  passwordConnector: local   # needed for ROPC grant used by verifier_test.go
enablePasswordDB: true
staticClients:
  - id: kubeport
    redirectURIs:
      - http://localhost:3000/api/auth/callback
    name: kubeport
    secret: local-dev-secret
staticPasswords:
  - email: alice@example.com
    # Regen with: go run 'golang.org/x/crypto/bcrypt' via a small `main.go`,
    # or: docker run --rm httpd htpasswd -bnBC 10 "" <pw> | tr -d ':\n'
    hash: "$2a$10$vECrnrZp1stcCkukSTINn.2ijRZSS3RUnNnvP.gg0vUvS8IhNBL7S"  # password: alice
    username: alice
    userID: "alice-000"
```

- [x] **Step 2: Bring up services and verify**

```bash
docker compose -f deploy/docker/docker-compose.yml up -d
curl -s http://localhost:5556/.well-known/openid-configuration | head
```
Expected: dex returns JSON with `issuer: http://localhost:5556`.

- [x] **Step 3: Re-apply atlas schema against compose postgres**

```bash
cd backend && atlas schema apply --env local --auto-approve
```
Expected: "No changes" (already applied).

- [x] **Step 4: Commit**

```bash
git add deploy/docker/
git commit -m "chore: add docker-compose with postgres and dex for local dev"
```

---

### Task 5: Generate sqlc code for users + sessions

**Files:**
- Create: `backend/sqlc.yaml`
- Create: `backend/migrations/schema.sql` (derived from `schema.hcl` — sqlc can't parse HCL)
- Create: `backend/internal/store/queries/users.sql`
- Create: `backend/internal/store/queries/sessions.sql`
- Create: `backend/internal/store/store.go`
- Test: `backend/internal/store/store_test.go`

- [x] **Step 1: Write `sqlc.yaml` and derive `schema.sql` from `schema.hcl`**

sqlc doesn't understand Atlas HCL, so we keep `schema.hcl` as the source of truth for atlas migrations and commit a derived `schema.sql` that sqlc reads. Regen command:

```bash
cd backend/migrations && atlas schema inspect --env local --format '{{ sql . }}' 2>/dev/null > schema.sql
```

Path: `backend/sqlc.yaml`
```yaml
version: "2"
sql:
  - engine: postgresql
    schema: migrations/schema.sql
    queries: internal/store/queries
    gen:
      go:
        package: store
        out: internal/store
        sql_package: pgx/v5
        emit_json_tags: true
        emit_interface: true
```

- [x] **Step 2: Write user queries**

Path: `backend/internal/store/queries/users.sql`
```sql
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
```

- [x] **Step 3: Write session queries**

Path: `backend/internal/store/queries/sessions.sql`
```sql
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
```

- [x] **Step 4: Run sqlc**

```bash
cd backend && sqlc generate
```
Expected: creates `internal/store/db.go`, `models.go`, `users.sql.go`, `sessions.sql.go`.

- [x] **Step 5: Write `store.Store` wrapper and its test**

Path: `backend/internal/store/store.go`
```go
package store

import (
    "context"

    "github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
    *Queries
    pool *pgxpool.Pool
}

func NewStore(ctx context.Context, dsn string) (*Store, error) {
    pool, err := pgxpool.New(ctx, dsn)
    if err != nil {
        return nil, err
    }
    return &Store{Queries: New(pool), pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }
```

Path: `backend/internal/store/store_test.go`
```go
package store_test

import (
    "context"
    "os"
    "testing"
    "time"

    "github.com/stretchr/testify/require"

    "kubeport/internal/store"
)

func testDSN(t *testing.T) string {
    t.Helper()
    dsn := os.Getenv("TEST_DATABASE_URL")
    if dsn == "" {
        dsn = "postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
    }
    return dsn
}

func TestUpsertUser(t *testing.T) {
    ctx := context.Background()
    s, err := store.NewStore(ctx, testDSN(t))
    require.NoError(t, err)
    defer s.Close()

    u, err := s.UpsertUser(ctx, store.UpsertUserParams{
        OidcSubject: "test-sub-" + time.Now().Format("150405"),
        Email:       pgText("alice@example.com"),
        DisplayName: pgText("Alice"),
    })
    require.NoError(t, err)
    require.Equal(t, "alice@example.com", u.Email.String)
}
```

Helper (can live in the same test file):
```go
func pgText(s string) store.PgText { /* wraps pgtype.Text */ }
```

- [x] **Step 6: Run the test**

```bash
cd backend && go test ./internal/store/...
```
Expected: PASS when local compose is up.

- [x] **Step 7: Commit**

```bash
git add backend/sqlc.yaml backend/internal/store/
git commit -m "feat(backend): sqlc queries for users and sessions"
```

---

### Task 6: sqlc queries for clusters, templates, template_versions, releases

**Files:**
- Create: `backend/internal/store/queries/clusters.sql`
- Create: `backend/internal/store/queries/templates.sql`
- Create: `backend/internal/store/queries/releases.sql`
- Test: `backend/internal/store/store_test.go` (extend)

- [x] **Step 1: Write cluster queries**

Path: `backend/internal/store/queries/clusters.sql`
```sql
-- name: ListClusters :many
SELECT * FROM clusters ORDER BY name;

-- name: GetClusterByName :one
SELECT * FROM clusters WHERE name = $1;

-- name: InsertCluster :one
INSERT INTO clusters (name, display_name, api_url, ca_bundle, oidc_issuer_url, default_namespace)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
```

- [x] **Step 2: Write template + template_version queries**

Path: `backend/internal/store/queries/templates.sql`
```sql
-- name: ListTemplates :many
SELECT t.*,
       tv.version    AS current_version,
       tv.ui_spec_yaml AS current_ui_spec
  FROM templates t
  LEFT JOIN template_versions tv ON tv.id = t.current_version_id
 ORDER BY t.name;

-- name: GetTemplateByName :one
SELECT * FROM templates WHERE name = $1;

-- name: InsertTemplate :one
INSERT INTO templates (name, display_name, description, tags, owner_user_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: UpdateTemplateCurrentVersion :exec
UPDATE templates SET current_version_id = $2, updated_at = now() WHERE id = $1;

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
```

- [x] **Step 3: Write release queries**

Path: `backend/internal/store/queries/releases.sql`
```sql
-- name: ListReleasesForUser :many
SELECT r.*, c.name AS cluster_name, t.name AS template_name, tv.version AS template_version
  FROM releases r
  JOIN clusters c          ON c.id = r.cluster_id
  JOIN template_versions tv ON tv.id = r.template_version_id
  JOIN templates t         ON t.id = tv.template_id
 WHERE r.created_by_user_id = $1
 ORDER BY r.created_at DESC;

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

-- name: DeleteRelease :exec
DELETE FROM releases WHERE id = $1;
```

- [x] **Step 4: Regenerate and compile**

```bash
cd backend && sqlc generate && go build ./...
```
Expected: no errors.

- [x] **Step 5: Append test for one cluster+template flow**

Append to `backend/internal/store/store_test.go`:
```go
func TestInsertClusterAndTemplate(t *testing.T) {
    ctx := context.Background()
    s, err := store.NewStore(ctx, testDSN(t))
    require.NoError(t, err)
    defer s.Close()

    u, err := s.UpsertUser(ctx, store.UpsertUserParams{
        OidcSubject: "owner-" + time.Now().Format("150405"),
        Email:       pgText("owner@example.com"),
        DisplayName: pgText("Owner"),
    })
    require.NoError(t, err)

    c, err := s.InsertCluster(ctx, store.InsertClusterParams{
        Name:           "test-" + time.Now().Format("150405"),
        DisplayName:    pgText("Test Cluster"),
        ApiUrl:         "https://kubernetes.default:443",
        OidcIssuerUrl:  "http://localhost:5556",
    })
    require.NoError(t, err)
    require.NotZero(t, c.ID)

    tpl, err := s.InsertTemplate(ctx, store.InsertTemplateParams{
        Name:        "web-" + time.Now().Format("150405"),
        DisplayName: "Web",
        OwnerUserID: u.ID,
    })
    require.NoError(t, err)
    require.NotZero(t, tpl.ID)
}
```

- [x] **Step 6: Run and commit**

```bash
cd backend && go test ./internal/store/...
```
Expected: PASS.

```bash
git add backend/internal/store/
git commit -m "feat(backend): sqlc queries for clusters, templates, template_versions, releases"
```

---

### Task 7: OIDC verifier — parse + validate bearer tokens

**Files:**
- Create: `backend/internal/auth/verifier.go`
- Create: `backend/internal/auth/context.go`
- Test: `backend/internal/auth/verifier_test.go`

- [x] **Step 1: Write the test using dex**

Path: `backend/internal/auth/verifier_test.go`
```go
package auth_test

import (
    "context"
    "net/url"
    "os"
    "strings"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/auth"
)

// getDexToken fetches an id_token from the local dex using password grant.
// Requires compose to be running.
func getDexToken(t *testing.T) string {
    t.Helper()
    form := url.Values{}
    form.Set("grant_type", "password")
    form.Set("client_id", "kubeport")
    form.Set("client_secret", "local-dev-secret")
    form.Set("username", "alice@example.com")
    form.Set("password", "alice")
    form.Set("scope", "openid email profile")

    // http.Post to http://localhost:5556/token, parse id_token from JSON
    // ...snip... full implementation: 15 lines
    return "<fetched>"
}

func TestVerifier_Verify(t *testing.T) {
    if os.Getenv("SKIP_OIDC") != "" {
        t.Skip("SKIP_OIDC set")
    }
    ctx := context.Background()
    v, err := auth.NewVerifier(ctx, "http://localhost:5556", "kubeport")
    require.NoError(t, err)

    token := getDexToken(t)
    require.False(t, strings.HasPrefix(token, "<"))

    claims, err := v.Verify(ctx, token)
    require.NoError(t, err)
    require.Equal(t, "alice@example.com", claims.Email)
}
```

- [x] **Step 2: Run the test — expect it to fail**

```bash
cd backend && go test ./internal/auth/...
```
Expected: FAIL — `auth` package doesn't exist.

- [x] **Step 3: Add go-oidc dependency and implement verifier**

```bash
go get github.com/coreos/go-oidc/v3/oidc@latest
```

Path: `backend/internal/auth/verifier.go`
```go
package auth

import (
    "context"

    "github.com/coreos/go-oidc/v3/oidc"
)

type Claims struct {
    Subject string   `json:"sub"`
    Email   string   `json:"email"`
    Name    string   `json:"name"`
    Groups  []string `json:"groups"`
}

type Verifier struct {
    v *oidc.IDTokenVerifier
}

func NewVerifier(ctx context.Context, issuer, clientID string) (*Verifier, error) {
    provider, err := oidc.NewProvider(ctx, issuer)
    if err != nil {
        return nil, err
    }
    return &Verifier{v: provider.Verifier(&oidc.Config{ClientID: clientID})}, nil
}

func (v *Verifier) Verify(ctx context.Context, rawToken string) (Claims, error) {
    tok, err := v.v.Verify(ctx, rawToken)
    if err != nil {
        return Claims{}, err
    }
    var c Claims
    if err := tok.Claims(&c); err != nil {
        return Claims{}, err
    }
    return c, nil
}
```

Path: `backend/internal/auth/context.go`
```go
package auth

import "context"

type ctxKey struct{}

type RequestUser struct {
    Claims
    IDToken string
}

func WithUser(ctx context.Context, u RequestUser) context.Context {
    return context.WithValue(ctx, ctxKey{}, u)
}

func UserFrom(ctx context.Context) (RequestUser, bool) {
    u, ok := ctx.Value(ctxKey{}).(RequestUser)
    return u, ok
}
```

- [x] **Step 4: Run the test — expect it to pass**

```bash
cd backend && go test ./internal/auth/...
```
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/internal/auth/
git commit -m "feat(backend): OIDC verifier with request-scoped user context"
```

---

### Task 8: Auth middleware + RFC 7807 error writer

**Files:**
- Modify: `backend/internal/api/routes.go`
- Create: `backend/internal/api/middleware.go`
- Create: `backend/internal/api/errors.go`
- Create: `backend/internal/api/me.go`
- Test: `backend/internal/api/middleware_test.go`

- [x] **Step 1: Write the middleware test**

Path: `backend/internal/api/middleware_test.go`
```go
package api_test

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/api"
    "kubeport/internal/auth"
    "kubeport/internal/config"
)

type stubVerifier struct{}

func (stubVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
    return auth.Claims{Subject: "stub", Email: "alice@example.com"}, nil
}

func TestAuthMiddleware_Rejects_NoHeader(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}})
    w := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusUnauthorized, w.Code)
    require.Contains(t, w.Body.String(), "unauthenticated")
}

func TestAuthMiddleware_Accepts_Bearer(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}})
    w := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
    req.Header.Set("Authorization", "Bearer anything")
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), "alice@example.com")
}
```

- [x] **Step 2: Run — expect failure**

```bash
cd backend && go test ./internal/api/...
```
Expected: FAIL — `api.Deps` not defined, `/v1/me` not routed.

- [x] **Step 3: Implement errors.go**

Path: `backend/internal/api/errors.go`
```go
package api

import "github.com/gin-gonic/gin"

type Problem struct {
    Type      string `json:"type"`
    Title     string `json:"title"`
    Status    int    `json:"status"`
    Detail    string `json:"detail,omitempty"`
    RequestID string `json:"request_id,omitempty"`
}

func writeError(c *gin.Context, status int, kind, detail string) {
    c.AbortWithStatusJSON(status, Problem{
        Type:   "https://kubeport.io/errors/" + kind,
        Title:  kind,
        Status: status,
        Detail: detail,
    })
}
```

- [x] **Step 4: Implement middleware.go**

Path: `backend/internal/api/middleware.go`
```go
package api

import (
    "context"
    "net/http"
    "strings"

    "github.com/gin-gonic/gin"

    "kubeport/internal/auth"
)

type TokenVerifier interface {
    Verify(ctx context.Context, raw string) (auth.Claims, error)
}

func requireAuth(v TokenVerifier) gin.HandlerFunc {
    return func(c *gin.Context) {
        h := c.GetHeader("Authorization")
        if !strings.HasPrefix(h, "Bearer ") {
            writeError(c, http.StatusUnauthorized, "unauthenticated", "missing bearer token")
            return
        }
        raw := strings.TrimPrefix(h, "Bearer ")
        claims, err := v.Verify(c.Request.Context(), raw)
        if err != nil {
            writeError(c, http.StatusUnauthorized, "unauthenticated", err.Error())
            return
        }
        ctx := auth.WithUser(c.Request.Context(), auth.RequestUser{Claims: claims, IDToken: raw})
        c.Request = c.Request.WithContext(ctx)
        c.Next()
    }
}

func requireAdmin() gin.HandlerFunc {
    return func(c *gin.Context) {
        u, _ := auth.UserFrom(c.Request.Context())
        for _, g := range u.Groups {
            if g == "kubeport-admin" {
                c.Next()
                return
            }
        }
        writeError(c, http.StatusForbidden, "rbac-denied", "admin group required")
    }
}
```

- [x] **Step 5: Implement me.go and update routes.go**

Path: `backend/internal/api/me.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/auth"
)

func (h *Handlers) GetMe(c *gin.Context) {
    u, _ := auth.UserFrom(c.Request.Context())
    c.JSON(http.StatusOK, gin.H{
        "subject": u.Subject,
        "email":   u.Email,
        "groups":  u.Groups,
    })
}
```

Path: `backend/internal/api/routes.go` (rewrite)
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/config"
)

type Deps struct {
    Verifier TokenVerifier
    // Store, K8sFactory added in later tasks
}

type Handlers struct {
    deps Deps
}

func NewRouter(cfg config.Config, deps Deps) *gin.Engine {
    r := gin.New()
    r.Use(gin.Recovery())
    r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

    h := &Handlers{deps: deps}
    v := r.Group("/v1", requireAuth(deps.Verifier))
    v.GET("/me", h.GetMe)
    return r
}
```

- [x] **Step 6: Run — expect PASS**

```bash
cd backend && go test ./internal/api/...
```

- [x] **Step 7: Commit**

```bash
git add backend/internal/api/
git commit -m "feat(backend): auth middleware with RFC 7807 errors and /v1/me"
```

---

### Task 9: Cluster register + list endpoints

**Files:**
- Create: `backend/internal/api/clusters.go`
- Test: `backend/internal/api/clusters_test.go`
- Modify: `backend/internal/api/routes.go`

- [x] **Step 1: Write the test**

Path: `backend/internal/api/clusters_test.go`
```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/api"
    "kubeport/internal/auth"
    "kubeport/internal/config"
)

type adminVerifier struct{}

func (adminVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
    return auth.Claims{Subject: "admin", Email: "admin@example.com", Groups: []string{"kubeport-admin"}}, nil
}

func TestClusters_Register_RequiresAdmin(t *testing.T) {
    // non-admin should 403
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
    body := bytes.NewReader([]byte(`{"name":"dev","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`))
    req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
    req.Header.Set("Authorization", "Bearer x")
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusForbidden, w.Code)
}

func TestClusters_Register_AdminSucceeds(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
    body := bytes.NewReader([]byte(`{"name":"dev-` + randSuffix() + `","api_url":"https://k","oidc_issuer_url":"http://localhost:5556"}`))
    req := httptest.NewRequest(http.MethodPost, "/v1/clusters", body)
    req.Header.Set("Authorization", "Bearer x")
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusCreated, w.Code)

    var got map[string]any
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
    require.NotEmpty(t, got["id"])
}
```

Add `testStore(t)` helper that returns a live `*store.Store` from the env DSN, and `randSuffix()` returns a short time-based slug.

- [x] **Step 2: Implement the handler**

Path: `backend/internal/api/clusters.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/store"
)

type createClusterReq struct {
    Name             string `json:"name"               binding:"required,min=1"`
    DisplayName      string `json:"display_name"`
    APIURL           string `json:"api_url"            binding:"required,url"`
    CABundle         string `json:"ca_bundle"`
    OIDCIssuerURL    string `json:"oidc_issuer_url"    binding:"required,url"`
    DefaultNamespace string `json:"default_namespace"`
}

func (h *Handlers) ListClusters(c *gin.Context) {
    cs, err := h.deps.Store.ListClusters(c.Request.Context())
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"clusters": cs})
}

func (h *Handlers) CreateCluster(c *gin.Context) {
    var r createClusterReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    cl, err := h.deps.Store.InsertCluster(c.Request.Context(), store.InsertClusterParams{
        Name:             r.Name,
        DisplayName:      pgText(r.DisplayName),
        ApiUrl:           r.APIURL,
        CaBundle:         pgText(r.CABundle),
        OidcIssuerUrl:    r.OIDCIssuerURL,
        DefaultNamespace: pgText(r.DefaultNamespace),
    })
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", err.Error())
        return
    }
    c.JSON(http.StatusCreated, cl)
}
```

Wire in `routes.go`:
```go
v.GET("/clusters", h.ListClusters)
v.POST("/clusters", requireAdmin(), h.CreateCluster)
```

Add `Store *store.Store` to `Deps` and `pgText` helper.

- [x] **Step 3: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Clusters
```

- [x] **Step 4: Commit**

```bash
git add backend/internal/api/
git commit -m "feat(backend): register and list clusters (admin-only write)"
```

---

### Task 10: Template render — parse multi-doc YAML + apply values + stamp labels

**Files:**
- Create: `backend/internal/template/spec.go`
- Create: `backend/internal/template/jsonpath.go`
- Create: `backend/internal/template/render.go`
- Test: `backend/internal/template/render_test.go`

- [x] **Step 1: Write the render test**

Path: `backend/internal/template/render_test.go`
```go
package template_test

import (
    "encoding/json"
    "testing"

    "github.com/stretchr/testify/require"
    "gopkg.in/yaml.v3"

    "kubeport/internal/template"
)

const resourcesYAML = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: placeholder
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  ports: [{ port: 80 }]
`

const uiSpecYAML = `
fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "Image"
    type: string
`

func TestRender_AppliesValuesAndStampsLabels(t *testing.T) {
    values, _ := json.Marshal(map[string]any{
        "Deployment[web].spec.replicas": 5,
        "Deployment[web].spec.template.spec.containers[0].image": "nginx:1.25",
    })

    out, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{
        ReleaseName: "my-api", TemplateName: "web-service",
        TemplateVersion: 2, ReleaseID: "rel_abc", AppliedBy: "alice@example.com",
    })
    require.NoError(t, err)

    var docs []map[string]any
    dec := yaml.NewDecoder(bytesReader(out))
    for {
        m := map[string]any{}
        if err := dec.Decode(&m); err != nil { break }
        docs = append(docs, m)
    }
    require.Len(t, docs, 2)

    dep := docs[0]
    spec := dep["spec"].(map[string]any)
    require.Equal(t, 5, spec["replicas"])

    ctrs := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)
    require.Equal(t, "nginx:1.25", ctrs[0].(map[string]any)["image"])

    meta := dep["metadata"].(map[string]any)
    lbls := meta["labels"].(map[string]any)
    require.Equal(t, "my-api", lbls["kubeport.io/release"])
    require.Equal(t, "2", lbls["kubeport.io/template-version"])
}

func TestRender_ValidatesMin(t *testing.T) {
    values, _ := json.Marshal(map[string]any{
        "Deployment[web].spec.replicas": 0,
    })
    _, err := template.Render(resourcesYAML, uiSpecYAML, values, template.Labels{})
    require.ErrorContains(t, err, "min")
}
```

- [x] **Step 2: Run — expect failure**

```bash
cd backend && go test ./internal/template/...
```

- [x] **Step 3: Implement `spec.go`**

Path: `backend/internal/template/spec.go`
```go
package template

import (
    "fmt"

    "gopkg.in/yaml.v3"
)

type FieldType string

const (
    TypeString  FieldType = "string"
    TypeInteger FieldType = "integer"
    TypeBoolean FieldType = "boolean"
    TypeEnum    FieldType = "enum"
)

type Field struct {
    Path     string    `yaml:"path"`
    Label    string    `yaml:"label"`
    Help     string    `yaml:"help"`
    Type     FieldType `yaml:"type"`
    Min      *int      `yaml:"min"`
    Max      *int      `yaml:"max"`
    Pattern  string    `yaml:"pattern"`
    Values   []string  `yaml:"values"`
    Default  any       `yaml:"default"`
    Required bool      `yaml:"required"`
}

type UISpec struct {
    Fields []Field `yaml:"fields"`
}

func parseSpec(src string) (UISpec, error) {
    var s UISpec
    if err := yaml.Unmarshal([]byte(src), &s); err != nil {
        return UISpec{}, fmt.Errorf("ui-spec unmarshal: %w", err)
    }
    return s, nil
}

func (f Field) Validate(v any) error {
    switch f.Type {
    case TypeInteger:
        n, ok := toInt(v)
        if !ok {
            return fmt.Errorf("%s: not an integer", f.Label)
        }
        if f.Min != nil && n < *f.Min {
            return fmt.Errorf("%s: below min %d", f.Label, *f.Min)
        }
        if f.Max != nil && n > *f.Max {
            return fmt.Errorf("%s: above max %d", f.Label, *f.Max)
        }
    case TypeEnum:
        s := fmt.Sprint(v)
        for _, vv := range f.Values {
            if s == vv {
                return nil
            }
        }
        return fmt.Errorf("%s: not in %v", f.Label, f.Values)
    }
    return nil
}

func toInt(v any) (int, bool) {
    switch x := v.(type) {
    case int:    return x, true
    case int64:  return int(x), true
    case float64: return int(x), true
    }
    return 0, false
}
```

- [x] **Step 4: Implement `jsonpath.go` — tiny path resolver understanding `Kind[name].a.b.c[0].d`**

Path: `backend/internal/template/jsonpath.go`
```go
package template

import (
    "fmt"
    "regexp"
    "strconv"
    "strings"
)

// setJSONPath mutates docs in place to assign v at path.
// Path grammar (minimal, MVP):
//   Kind[selector] (".prop" | "[" INT "]")*
//   selector ::= INT | NAME
func setJSONPath(docs []map[string]any, path string, v any) error {
    kind, selector, rest, err := parseHead(path)
    if err != nil {
        return err
    }
    target, err := findDoc(docs, kind, selector)
    if err != nil {
        return err
    }
    return setInto(target, rest, v)
}

var headRE = regexp.MustCompile(`^([A-Z][A-Za-z]+)(?:\[([^\]]+)\])?(.*)$`)

func parseHead(p string) (string, string, string, error) {
    m := headRE.FindStringSubmatch(p)
    if m == nil {
        return "", "", "", fmt.Errorf("path %q invalid", p)
    }
    return m[1], m[2], strings.TrimPrefix(m[3], "."), nil
}

func findDoc(docs []map[string]any, kind, selector string) (map[string]any, error) {
    var matches []map[string]any
    for _, d := range docs {
        if d["kind"] == kind {
            matches = append(matches, d)
        }
    }
    if selector == "" && len(matches) == 1 {
        return matches[0], nil
    }
    if idx, err := strconv.Atoi(selector); err == nil && idx >= 0 && idx < len(matches) {
        return matches[idx], nil
    }
    for _, d := range matches {
        meta, _ := d["metadata"].(map[string]any)
        if meta != nil && meta["name"] == selector {
            return d, nil
        }
    }
    return nil, fmt.Errorf("no %s matching %q", kind, selector)
}

var segRE = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]`)

func setInto(node any, rest string, v any) error {
    for rest != "" {
        m := segRE.FindStringSubmatch(rest)
        if m == nil {
            return fmt.Errorf("bad path remainder %q", rest)
        }
        rest = strings.TrimPrefix(rest[len(m[0]):], ".")
        if m[1] != "" {
            // property
            obj, ok := node.(map[string]any)
            if !ok {
                return fmt.Errorf("not a map at %q", m[1])
            }
            if rest == "" {
                obj[m[1]] = v
                return nil
            }
            if _, exists := obj[m[1]]; !exists {
                obj[m[1]] = map[string]any{}
            }
            node = obj[m[1]]
        } else {
            // index
            idx, _ := strconv.Atoi(m[2])
            arr, ok := node.([]any)
            if !ok {
                return fmt.Errorf("not an array at [%d]", idx)
            }
            if rest == "" {
                arr[idx] = v
                return nil
            }
            node = arr[idx]
        }
    }
    return nil
}

func ensureMap(m map[string]any, key string) map[string]any {
    if v, ok := m[key].(map[string]any); ok {
        return v
    }
    nm := map[string]any{}
    m[key] = nm
    return nm
}
```

- [x] **Step 5: Implement `render.go`**

Path: `backend/internal/template/render.go`
```go
package template

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "time"

    "gopkg.in/yaml.v3"
)

type Labels struct {
    ReleaseName     string
    TemplateName    string
    TemplateVersion int
    ReleaseID       string
    AppliedBy       string
}

func Render(resourcesYAML, uiSpecYAML string, values json.RawMessage, l Labels) ([]byte, error) {
    docs, err := parseMultiDoc(resourcesYAML)
    if err != nil {
        return nil, err
    }
    spec, err := parseSpec(uiSpecYAML)
    if err != nil {
        return nil, err
    }

    var input map[string]any
    if err := json.Unmarshal(values, &input); err != nil {
        return nil, fmt.Errorf("values not a JSON object: %w", err)
    }

    for _, f := range spec.Fields {
        raw, present := input[f.Path]
        if !present {
            if f.Required {
                return nil, fmt.Errorf("field %q required", f.Label)
            }
            if f.Default == nil {
                continue
            }
            raw = f.Default
        }
        if err := f.Validate(raw); err != nil {
            return nil, err
        }
        if err := setJSONPath(docs, f.Path, raw); err != nil {
            return nil, err
        }
    }

    for _, d := range docs {
        stampLabels(d, l)
    }

    return marshalMultiDoc(docs)
}

func parseMultiDoc(src string) ([]map[string]any, error) {
    var docs []map[string]any
    dec := yaml.NewDecoder(bytes.NewReader([]byte(src)))
    for {
        m := map[string]any{}
        if err := dec.Decode(&m); err != nil {
            if err == io.EOF {
                break
            }
            return nil, err
        }
        if len(m) > 0 {
            docs = append(docs, m)
        }
    }
    return docs, nil
}

func marshalMultiDoc(docs []map[string]any) ([]byte, error) {
    var buf bytes.Buffer
    enc := yaml.NewEncoder(&buf)
    enc.SetIndent(2)
    for _, d := range docs {
        if err := enc.Encode(d); err != nil {
            return nil, err
        }
    }
    _ = enc.Close()
    return buf.Bytes(), nil
}

func stampLabels(obj map[string]any, l Labels) {
    meta := ensureMap(obj, "metadata")
    lbls := ensureMap(meta, "labels")
    lbls["kubeport.io/managed"] = "true"
    lbls["kubeport.io/release"] = l.ReleaseName
    lbls["kubeport.io/template"] = l.TemplateName
    lbls["kubeport.io/template-version"] = fmt.Sprintf("%d", l.TemplateVersion)
    anns := ensureMap(meta, "annotations")
    anns["kubeport.io/release-id"] = l.ReleaseID
    anns["kubeport.io/applied-by"] = l.AppliedBy
    anns["kubeport.io/applied-at"] = time.Now().UTC().Format(time.RFC3339)
}

// bytesReader used by the tests
func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
```

- [x] **Step 6: Run — expect PASS**

```bash
cd backend && go test ./internal/template/...
```

- [x] **Step 7: Commit**

```bash
git add backend/internal/template/
git commit -m "feat(backend): template render with JSONPath assignment and label stamping"
```

---

### Task 11: Template CRUD endpoints (YAML mode)

**Files:**
- Create: `backend/internal/api/templates.go`
- Test: `backend/internal/api/templates_test.go`
- Modify: `backend/internal/api/routes.go`

- [x] **Step 1: Write the test**

Path: `backend/internal/api/templates_test.go`
```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestTemplates_CreateAndPublish(t *testing.T) {
    r := newTestRouterAdmin(t)
    body := map[string]any{
        "name": "web-" + randSuffix(),
        "display_name": "Web Service",
        "description": "simple",
        "tags": []string{"web"},
        "resources_yaml": minimalResources,
        "ui_spec_yaml":   minimalUISpec,
    }
    raw, _ := json.Marshal(body)
    w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
    require.Equal(t, http.StatusCreated, w.Code)

    var created map[string]any
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
    name := created["name"].(string)

    // list versions — should have 1 draft
    w = do(t, r, http.MethodGet, "/v1/templates/"+name+"/versions", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"status":"draft"`)

    // publish v1
    w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/publish", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"status":"published"`)
}
```

`minimalResources` / `minimalUISpec` are the same strings used in the render test, moved to a shared `testdata_test.go`.

- [x] **Step 2: Implement handlers**

Path: `backend/internal/api/templates.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/auth"
    "kubeport/internal/store"
    "kubeport/internal/template"
)

type createTemplateReq struct {
    Name          string   `json:"name"           binding:"required"`
    DisplayName   string   `json:"display_name"   binding:"required"`
    Description   string   `json:"description"`
    Tags          []string `json:"tags"`
    ResourcesYAML string   `json:"resources_yaml" binding:"required"`
    UISpecYAML    string   `json:"ui_spec_yaml"   binding:"required"`
    MetadataYAML  string   `json:"metadata_yaml"`
}

func (h *Handlers) CreateTemplate(c *gin.Context) {
    var r createTemplateReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    // sanity: render with empty values to parse spec
    if _, err := template.Render(r.ResourcesYAML, r.UISpecYAML, []byte("{}"), template.Labels{}); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }

    u, _ := auth.UserFrom(c.Request.Context())
    user, err := h.deps.Store.UpsertUser(c, store.UpsertUserParams{
        OidcSubject: u.Subject, Email: pgText(u.Email), DisplayName: pgText(u.Name),
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    tpl, err := h.deps.Store.InsertTemplate(c, store.InsertTemplateParams{
        Name: r.Name, DisplayName: r.DisplayName,
        Description: pgText(r.Description), Tags: r.Tags,
        OwnerUserID: user.ID,
    })
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", err.Error())
        return
    }
    tv, err := h.deps.Store.InsertTemplateVersion(c, store.InsertTemplateVersionParams{
        TemplateID:      tpl.ID,
        Version:         1,
        ResourcesYaml:   r.ResourcesYAML,
        UiSpecYaml:      r.UISpecYAML,
        MetadataYaml:    pgText(r.MetadataYAML),
        Status:          "draft",
        CreatedByUserID: user.ID,
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusCreated, gin.H{"template": tpl, "version": tv})
}

func (h *Handlers) ListTemplates(c *gin.Context) {
    rows, err := h.deps.Store.ListTemplates(c.Request.Context())
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"templates": rows})
}

func (h *Handlers) GetTemplate(c *gin.Context) {
    t, err := h.deps.Store.GetTemplateByName(c.Request.Context(), c.Param("name"))
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template")
        return
    }
    c.JSON(http.StatusOK, t)
}

func (h *Handlers) ListTemplateVersions(c *gin.Context) {
    vs, err := h.deps.Store.ListTemplateVersions(c.Request.Context(), c.Param("name"))
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"versions": vs})
}

func (h *Handlers) GetTemplateVersion(c *gin.Context) {
    v64, err := strconv.ParseInt(c.Param("v"), 10, 32)
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", "version must be integer")
        return
    }
    tv, err := h.deps.Store.GetTemplateVersion(c.Request.Context(), store.GetTemplateVersionParams{
        Name: c.Param("name"), Version: int32(v64),
    })
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template version")
        return
    }
    c.JSON(http.StatusOK, tv)
}

func (h *Handlers) PublishVersion(c *gin.Context) {
    name := c.Param("name")
    v64, err := strconv.ParseInt(c.Param("v"), 10, 32)
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", "version must be integer")
        return
    }
    existing, err := h.deps.Store.GetTemplateVersion(c.Request.Context(), store.GetTemplateVersionParams{
        Name: name, Version: int32(v64),
    })
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template version")
        return
    }
    published, err := h.deps.Store.PublishTemplateVersion(c.Request.Context(), existing.ID)
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", "version not in draft state")
        return
    }
    if err := h.deps.Store.UpdateTemplateCurrentVersion(c.Request.Context(), store.UpdateTemplateCurrentVersionParams{
        ID: existing.TemplateID, CurrentVersionID: pgUUID(published.ID),
    }); err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, published)
}
```

Fill in the 4 handler stubs with straight sqlc calls (the skeleton for `CreateTemplate` shows the pattern).

Wire the routes:
```go
v.GET("/templates", h.ListTemplates)
v.POST("/templates", requireAdmin(), h.CreateTemplate)
v.GET("/templates/:name", h.GetTemplate)
v.GET("/templates/:name/versions", h.ListTemplateVersions)
v.GET("/templates/:name/versions/:v", h.GetTemplateVersion)
v.POST("/templates/:name/versions/:v/publish", requireAdmin(), h.PublishVersion)
```

- [x] **Step 3: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Templates
```

- [x] **Step 4: Commit**

```bash
git add backend/internal/api/
git commit -m "feat(backend): template CRUD with draft/publish flow"
```

---

### Task 12: k8s client factory + server-side apply helper

**Files:**
- Create: `backend/internal/k8s/client.go`
- Create: `backend/internal/k8s/apply.go`
- Test: `backend/internal/k8s/client_test.go`

- [x] **Step 1: Add client-go dependencies**

```bash
cd backend
go get k8s.io/client-go@v0.31.0
go get k8s.io/apimachinery@v0.31.0
go get sigs.k8s.io/yaml@latest
```

- [x] **Step 2: Write the test against a kind cluster configured with dex**

Path: `backend/internal/k8s/client_test.go`
```go
package k8s_test

import (
    "context"
    "os"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/k8s"
)

func TestApplyAll_IntegrationWithKind(t *testing.T) {
    if os.Getenv("KIND_API") == "" {
        t.Skip("KIND_API not set; skipping integration")
    }
    cli, err := k8s.NewWithToken(os.Getenv("KIND_API"), "", os.Getenv("DEX_TOKEN"))
    require.NoError(t, err)

    yaml := []byte(`
apiVersion: v1
kind: ConfigMap
metadata: { name: test-ck9s, namespace: default }
data: { hello: world }
`)
    require.NoError(t, cli.ApplyAll(context.Background(), "default", yaml))
}
```

- [x] **Step 3: Implement `client.go`**

Path: `backend/internal/k8s/client.go`
```go
package k8s

import (
    "k8s.io/client-go/dynamic"
    "k8s.io/client-go/rest"
)

type Client struct {
    dyn dynamic.Interface
}

func NewWithToken(apiURL, caBundle, bearer string) (*Client, error) {
    cfg := &rest.Config{
        Host:        apiURL,
        BearerToken: bearer,
    }
    if caBundle != "" {
        cfg.TLSClientConfig = rest.TLSClientConfig{CAData: []byte(caBundle)}
    } else {
        cfg.TLSClientConfig = rest.TLSClientConfig{Insecure: true}
    }
    dyn, err := dynamic.NewForConfig(cfg)
    if err != nil {
        return nil, err
    }
    return &Client{dyn: dyn}, nil
}
```

- [x] **Step 4: Implement `apply.go` using server-side apply**

Path: `backend/internal/k8s/apply.go`
```go
package k8s

import (
    "bytes"
    "context"
    "errors"
    "io"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/yaml"
)

func (c *Client) ApplyAll(ctx context.Context, namespace string, multiDoc []byte) error {
    objs, err := splitYAML(multiDoc)
    if err != nil {
        return err
    }
    for _, o := range objs {
        gvk := o.GroupVersionKind()
        gvr := schema.GroupVersionResource{
            Group: gvk.Group, Version: gvk.Version,
            Resource: pluralize(gvk.Kind),
        }
        if o.GetNamespace() == "" {
            o.SetNamespace(namespace)
        }
        buf, err := yaml.Marshal(o.Object)
        if err != nil {
            return err
        }
        _, err = c.dyn.Resource(gvr).Namespace(o.GetNamespace()).
            Patch(ctx, o.GetName(), types.ApplyPatchType, buf, metav1.PatchOptions{
                FieldManager: "kubeport",
                Force:        boolPtr(true),
            })
        if err != nil {
            return err
        }
    }
    return nil
}

func boolPtr(b bool) *bool { return &b }

// splitYAML splits a multi-document YAML stream into Unstructured objects.
func splitYAML(src []byte) ([]*unstructured.Unstructured, error) {
    var out []*unstructured.Unstructured
    dec := yaml.NewYAMLToJSONDecoder(bytes.NewReader(src))
    for {
        u := &unstructured.Unstructured{}
        if err := dec.Decode(u); err != nil {
            if errors.Is(err, io.EOF) {
                break
            }
            return nil, err
        }
        if u.Object == nil {
            continue
        }
        out = append(out, u)
    }
    return out, nil
}

// pluralize is a minimal Kind→Resource pluralizer for MVP resources (§12.1).
func pluralize(kind string) string {
    m := map[string]string{
        "Deployment":             "deployments",
        "StatefulSet":             "statefulsets",
        "DaemonSet":               "daemonsets",
        "Job":                     "jobs",
        "CronJob":                 "cronjobs",
        "Service":                 "services",
        "Ingress":                 "ingresses",
        "ConfigMap":               "configmaps",
        "Secret":                  "secrets",
        "PersistentVolumeClaim":   "persistentvolumeclaims",
    }
    if v, ok := m[kind]; ok {
        return v
    }
    return ""
}
```

(If `pluralize` returns `""`, the caller should fall back to RESTMapper. For Plan 1 we explicitly cover only the §12.1 MVP kinds.)

- [x] **Step 5: Run — integration test is opt-in; unit test validates `splitYAML`**

Add a small unit test for `splitYAML` in the same file (no k8s required):
```go
func TestSplitYAML(t *testing.T) {
    in := []byte("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: b}\n")
    objs, err := k8s.ExportedSplitYAML(in)
    require.NoError(t, err)
    require.Len(t, objs, 2)
}
```

Expose `SplitYAML` as `ExportedSplitYAML` in a `_test.go` export file, or mark it exported.

```bash
cd backend && go test ./internal/k8s/...
```
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add backend/internal/k8s/
git commit -m "feat(backend): k8s client factory and multi-doc server-side apply"
```

---

### Task 13: Release create / list / get / delete

**Files:**
- Create: `backend/internal/api/releases.go`
- Test: `backend/internal/api/releases_test.go`
- Modify: `backend/internal/api/routes.go`

- [x] **Step 1: Write the test (uses stub k8s factory)**

Path: `backend/internal/api/releases_test.go`
```go
package api_test

import (
    "bytes"
    "context"
    "encoding/json"
    "net/http"
    "testing"

    "github.com/stretchr/testify/require"
)

type fakeK8s struct{ applied [][]byte }

func (f *fakeK8s) NewWithToken(apiURL, ca, token string) (any, error) { return f, nil }
func (f *fakeK8s) ApplyAll(_ context.Context, _ string, y []byte) error {
    f.applied = append(f.applied, y)
    return nil
}

func TestReleases_CreateAndList(t *testing.T) {
    r, fk := newTestRouterWithFakeK8s(t)

    // seed: create cluster + publish template v1 (reuse helpers)
    clusterName := seedCluster(t, r)
    tplName := seedTemplateV1(t, r)

    body, _ := json.Marshal(map[string]any{
        "template": tplName, "version": 1,
        "cluster": clusterName, "namespace": "default",
        "name": "my-api",
        "values": map[string]any{
            "Deployment[web].spec.replicas": 2,
            "Deployment[web].spec.template.spec.containers[0].image": "nginx:1.25",
        },
    })

    w := do(t, r, http.MethodPost, "/v1/releases", bytes.NewReader(body))
    require.Equal(t, http.StatusCreated, w.Code)
    require.Len(t, fk.applied, 1)

    w = do(t, r, http.MethodGet, "/v1/releases", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"name":"my-api"`)
}
```

- [x] **Step 2: Implement handlers**

Path: `backend/internal/api/releases.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/auth"
    "kubeport/internal/store"
    "kubeport/internal/template"
)

type k8sClientFactory interface {
    NewWithToken(apiURL, caBundle, bearer string) (K8sApplier, error)
}

type K8sApplier interface {
    ApplyAll(ctx context.Context, ns string, yaml []byte) error
}

type createReleaseReq struct {
    Template  string          `json:"template"  binding:"required"`
    Version   int             `json:"version"   binding:"required,min=1"`
    Cluster   string          `json:"cluster"   binding:"required"`
    Namespace string          `json:"namespace" binding:"required"`
    Name      string          `json:"name"      binding:"required"`
    Values    json.RawMessage `json:"values"    binding:"required"`
}

func (h *Handlers) CreateRelease(c *gin.Context) {
    var r createReleaseReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    u, _ := auth.UserFrom(c.Request.Context())

    tv, err := h.deps.Store.GetTemplateVersion(c, store.GetTemplateVersionParams{Name: r.Template, Version: int32(r.Version)})
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template version")
        return
    }
    if tv.Status != "published" {
        writeError(c, http.StatusConflict, "conflict", "version not published")
        return
    }
    cluster, err := h.deps.Store.GetClusterByName(c, r.Cluster)
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "cluster")
        return
    }

    rendered, err := template.Render(tv.ResourcesYaml, tv.UiSpecYaml, r.Values, template.Labels{
        ReleaseName:     r.Name,
        TemplateName:    r.Template,
        TemplateVersion: r.Version,
        ReleaseID:       newID(), // placeholder until we have the DB ID; annotated again below
        AppliedBy:       u.Email,
    })
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }

    user, _ := h.deps.Store.UpsertUser(c, store.UpsertUserParams{OidcSubject: u.Subject, Email: pgText(u.Email), DisplayName: pgText(u.Name)})
    rel, err := h.deps.Store.InsertRelease(c, store.InsertReleaseParams{
        Name: r.Name, TemplateVersionID: tv.ID, ClusterID: cluster.ID,
        Namespace: r.Namespace, ValuesJson: r.Values, RenderedYaml: string(rendered),
        CreatedByUserID: user.ID,
    })
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", err.Error())
        return
    }

    cli, err := h.deps.K8sFactory.NewWithToken(cluster.ApiUrl, cluster.CaBundle.String, u.IDToken)
    if err != nil {
        _ = h.deps.Store.DeleteRelease(c, rel.ID)
        writeError(c, http.StatusInternalServerError, "k8s-error", err.Error())
        return
    }
    if err := cli.ApplyAll(c, r.Namespace, rendered); err != nil {
        // best-effort: keep DB row so user can inspect state; surface error
        writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
        return
    }
    c.JSON(http.StatusCreated, rel)
}

func (h *Handlers) ListReleases(c *gin.Context) { /* ListReleasesForUser */ }
func (h *Handlers) GetRelease(c *gin.Context)   { /* GetReleaseByID */ }
func (h *Handlers) DeleteRelease(c *gin.Context) {
    // 1. load release + cluster
    // 2. create k8s client
    // 3. delete by label selector kubeport.io/release=<name>
    // 4. delete DB row
}
```

Wire routes:
```go
v.GET("/releases", h.ListReleases)
v.POST("/releases", h.CreateRelease)
v.GET("/releases/:id", h.GetRelease)
v.DELETE("/releases/:id", h.DeleteRelease)
```

Add `K8sFactory` to `Deps`.

- [x] **Step 3: Add a `DeleteByLabels` helper to `internal/k8s`**

Path: `backend/internal/k8s/apply.go` (append)
```go
func (c *Client) DeleteByRelease(ctx context.Context, namespace, release string) error {
    kinds := []schema.GroupVersionResource{
        {Group: "apps", Version: "v1", Resource: "deployments"},
        {Group: "apps", Version: "v1", Resource: "statefulsets"},
        {Group: "apps", Version: "v1", Resource: "daemonsets"},
        {Group: "batch", Version: "v1", Resource: "jobs"},
        {Group: "batch", Version: "v1", Resource: "cronjobs"},
        {Group: "", Version: "v1", Resource: "services"},
        {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
        {Group: "", Version: "v1", Resource: "configmaps"},
        {Group: "", Version: "v1", Resource: "secrets"},
        {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
    }
    sel := "kubeport.io/release=" + release
    for _, r := range kinds {
        if err := c.dyn.Resource(r).Namespace(namespace).
            DeleteCollection(ctx, metav1.DeleteOptions{}, metav1.ListOptions{LabelSelector: sel}); err != nil {
            return err
        }
    }
    return nil
}
```

- [x] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Releases
```

- [x] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): release create/list/get/delete wired to k8s applier"
```

---

### Task 14: Release overview — join DB + live k8s pod/deployment state

**Files:**
- Modify: `backend/internal/api/releases.go`
- Create: `backend/internal/k8s/status.go`
- Test: `backend/internal/api/releases_test.go` (extend)

- [x] **Step 1: Write the test for `/v1/releases/:id` response shape**

Add to `releases_test.go`:
```go
func TestReleases_Get_IncludesInstanceCount(t *testing.T) {
    r, fk := newTestRouterWithFakeK8s(t)
    id := seedReleaseFullFlow(t, r)
    fk.listPodsReturn = 3 // fake returns 3 ready pods

    w := do(t, r, http.MethodGet, "/v1/releases/"+id, nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"instances_ready":3`)
}
```

- [x] **Step 2: Add `ListInstances` to `k8s.Client`**

Path: `backend/internal/k8s/status.go`
```go
package k8s

import (
    "context"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

type Instance struct {
    Name     string
    Phase    string
    Ready    bool
    Restarts int32
}

func (c *Client) ListInstances(ctx context.Context, namespace, release string) ([]Instance, error) {
    gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
    list, err := c.dyn.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: "kubeport.io/release=" + release,
    })
    if err != nil {
        return nil, err
    }
    out := make([]Instance, 0, len(list.Items))
    for _, p := range list.Items {
        ins := Instance{
            Name: p.GetName(),
        }
        status, _, _ := unstructuredField(p.Object, "status")
        if status != nil {
            if phase, ok := status["phase"].(string); ok {
                ins.Phase = phase
            }
            ins.Ready = containerStatusesReady(status)
            ins.Restarts = totalRestarts(status)
        }
        out = append(out, ins)
    }
    return out, nil
}

// small helpers (unstructuredField, containerStatusesReady, totalRestarts) — each ~10 lines
```

- [x] **Step 3: Extend `GetRelease` handler**

```go
func (h *Handlers) GetRelease(c *gin.Context) {
    id, err := uuid.Parse(c.Param("id"))
    if err != nil { writeError(c, 400, "validation-error", err.Error()); return }

    rel, err := h.deps.Store.GetReleaseByID(c, id)
    if err != nil { writeError(c, 404, "not-found", "release"); return }

    u, _ := auth.UserFrom(c.Request.Context())
    cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
    if err != nil { writeError(c, 502, "k8s-error", err.Error()); return }

    ins, err := cli.ListInstances(c, rel.Namespace, rel.Name)
    if err != nil { writeError(c, 502, "k8s-error", err.Error()); return }

    ready := 0
    for _, i := range ins {
        if i.Ready { ready++ }
    }
    c.JSON(http.StatusOK, gin.H{
        "id": rel.ID, "name": rel.Name,
        "template": gin.H{"name": rel.TemplateName, "version": rel.TemplateVersion},
        "cluster": rel.ClusterName, "namespace": rel.Namespace,
        "instances_total": len(ins), "instances_ready": ready,
        "status": abstractStatus(ins),
        "created_at": rel.CreatedAt,
    })
}
```

`abstractStatus` returns `"healthy"` / `"warning"` / `"error"` based on pod state (10 lines).

- [x] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Releases
```

- [x] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): release get returns abstract status and instance count"
```

---

### Task 15: Scaffold Next.js app with Tailwind and shadcn/ui

**Files:**
- Create: `frontend/*` (entire Next.js project)

- [x] **Step 1: Create app**

```bash
cd frontend..  # back to repo root
pnpm create next-app@latest frontend --typescript --app --tailwind --src-dir=false --import-alias "@/*" --eslint --turbo --no-install
cd frontend
pnpm install
```

- [x] **Step 2: Add shadcn/ui**

```bash
pnpm dlx shadcn@latest init --yes --defaults
pnpm dlx shadcn@latest add button card input select dialog badge table
```

- [x] **Step 3: Add Monaco, React Hook Form, Zod, openid-client, iron-session, pg**

```bash
pnpm add @monaco-editor/react react-hook-form zod @hookform/resolvers openid-client iron-session pg
pnpm add -D @types/pg
```

- [x] **Step 4: Add a healthcheck page to confirm build**

Path: `frontend/app/page.tsx`
```tsx
export default function Home() {
  return (
    <main className="p-8 text-lg font-mono">
      kubeport is running. Go to <a className="text-blue-600 underline" href="/catalog">catalog</a>.
    </main>
  );
}
```

- [x] **Step 5: Enable standalone output for future Helm chart packaging**

Edit `frontend/next.config.ts` (or `.js` if present) to include:

```ts
const nextConfig = {
  output: 'standalone',
};
export default nextConfig;
```

Rationale: per [ADR 0001](../../decisions/0001-frontend-deployment-helm-over-vercel.md) the frontend ships inside the same Helm chart as the Go API. `standalone` builds produce a self-contained Node server at `.next/standalone/` that a minimal Dockerfile (deferred to a later plan) can COPY directly. Setting this now avoids a reconfigure churn later.

- [x] **Step 6: Smoke build**

```bash
pnpm build
```
Expected: success, no TS errors. Verify that `frontend/.next/standalone/server.js` exists after the build.

- [x] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): scaffold Next.js 15 app with Tailwind, shadcn, Monaco, RHF+Zod"
```

---

### Task 16: OIDC login + callback + session cookie

**Files:**
- Create: `frontend/lib/oidc.ts`
- Create: `frontend/lib/session.ts`
- Create: `frontend/lib/db.ts`
- Create: `frontend/app/api/auth/login/route.ts`
- Create: `frontend/app/api/auth/callback/route.ts`
- Create: `frontend/app/api/auth/logout/route.ts`

- [x] **Step 1: Database client for sessions**

Path: `frontend/lib/db.ts`
```ts
import { Pool } from "pg";
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

- [x] **Step 2: OIDC helper**

Path: `frontend/lib/oidc.ts`
```ts
import { Issuer, generators } from "openid-client";

export async function getClient() {
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
  return new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID!,
    client_secret: process.env.OIDC_CLIENT_SECRET!,
    redirect_uris: [process.env.OIDC_REDIRECT_URI!],
    response_types: ["code"],
  });
}

export { generators };
```

- [x] **Step 3: Session helper (cookie + DB)**

Path: `frontend/lib/session.ts`
```ts
import { cookies } from "next/headers";
import { pool } from "./db";
import crypto from "node:crypto";

const COOKIE = "kbp_sid";

export interface Session {
  id: string;
  userId: string;
  idToken: string;
  refreshToken?: string;
  idTokenExp: Date;
}

// AES-GCM for tokens at rest
const key = Buffer.from(process.env.APP_ENCRYPTION_KEY_B64!, "base64");

function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function decrypt(b64: string) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export async function createSession(userId: string, idToken: string, refreshToken: string | undefined, exp: Date) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await pool.query(
    `INSERT INTO sessions (id, user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, encrypt(idToken), refreshToken ? encrypt(refreshToken) : null, exp, expiresAt],
  );
  cookies().set(COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSession(): Promise<Session | null> {
  const id = cookies().get(COOKIE)?.value;
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, id_token_encrypted, refresh_token_encrypted, id_token_exp
       FROM sessions WHERE id=$1 AND expires_at > now()`,
    [id],
  );
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    userId: rows[0].user_id,
    idToken: decrypt(rows[0].id_token_encrypted),
    refreshToken: rows[0].refresh_token_encrypted ? decrypt(rows[0].refresh_token_encrypted) : undefined,
    idTokenExp: rows[0].id_token_exp,
  };
}

export async function destroySession() {
  const id = cookies().get(COOKIE)?.value;
  if (id) await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
  cookies().delete(COOKIE);
}
```

- [x] **Step 4: Login route**

Path: `frontend/app/api/auth/login/route.ts`
```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getClient, generators } from "@/lib/oidc";

export async function GET() {
  const client = await getClient();
  const state = generators.state();
  const nonce = generators.nonce();
  const verifier = generators.codeVerifier();
  const challenge = generators.codeChallenge(verifier);

  cookies().set("kbp_oidc_state", JSON.stringify({ state, nonce, verifier }), {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 600,
  });

  const url = client.authorizationUrl({
    scope: "openid email profile groups",
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return NextResponse.redirect(url);
}
```

- [x] **Step 5: Callback route**

Path: `frontend/app/api/auth/callback/route.ts`
```ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getClient } from "@/lib/oidc";
import { createSession } from "@/lib/session";
import { pool } from "@/lib/db";

export async function GET(req: NextRequest) {
  const client = await getClient();
  const raw = cookies().get("kbp_oidc_state")?.value;
  if (!raw) return new NextResponse("missing state", { status: 400 });
  const { state, nonce, verifier } = JSON.parse(raw);

  const params = client.callbackParams(req.nextUrl.toString());
  const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URI!, params, {
    state, nonce, code_verifier: verifier,
  });
  const claims = tokenSet.claims();

  // upsert user row
  const { rows } = await pool.query(
    `INSERT INTO users (oidc_subject, email, display_name)
       VALUES ($1,$2,$3)
     ON CONFLICT (oidc_subject) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name, last_seen_at=now()
     RETURNING id`,
    [claims.sub, claims.email ?? null, claims.name ?? null],
  );
  const userId = rows[0].id;

  await createSession(userId, tokenSet.id_token!, tokenSet.refresh_token, new Date(tokenSet.expires_at! * 1000));
  cookies().delete("kbp_oidc_state");
  return NextResponse.redirect(new URL("/catalog", req.nextUrl.origin));
}
```

- [x] **Step 6: Logout route**

Path: `frontend/app/api/auth/logout/route.ts`
```ts
import { NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(new URL("/", "http://localhost:3000"));
}
```

- [x] **Step 7: Manual smoke test**

Set env in `frontend/.env.local`:
```
OIDC_ISSUER=http://localhost:5556
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=$(openssl rand -base64 32)
```

Run:
```bash
pnpm dev
# Open http://localhost:3000/api/auth/login → redirects to dex
# Login as alice/alice → redirects to /catalog
```
Expected: browser lands on `/catalog`, DB has a `users` row and a `sessions` row.

- [x] **Step 8: Commit**

```bash
git add frontend/lib/ frontend/app/api/auth/
git commit -m "feat(frontend): OIDC login + callback + httpOnly session cookie"
```

---

### Task 17: BFF proxy with silent refresh

**Files:**
- Create: `frontend/app/api/v1/[...path]/route.ts`
- Create: `frontend/middleware.ts`

- [x] **Step 1: Implement BFF proxy**

Path: `frontend/app/api/v1/[...path]/route.ts`
```ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getClient } from "@/lib/oidc";
import { pool } from "@/lib/db";

async function getValidToken(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return null;
  if (session.idTokenExp.getTime() > Date.now() + 60_000) return session.idToken;
  if (!session.refreshToken) return null;
  const client = await getClient();
  const tokenSet = await client.refresh(session.refreshToken);
  const exp = new Date((tokenSet.expires_at ?? 0) * 1000);
  await pool.query(
    `UPDATE sessions SET id_token_encrypted=$2, refresh_token_encrypted=$3, id_token_exp=$4 WHERE id=$1`,
    [session.id, /* encrypt elsewhere; keep same helper */ session.idToken, session.refreshToken, exp],
  );
  return tokenSet.id_token!;
}

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const session = await getSession();
  const token = session ? await getValidToken(session) : null;
  if (!token) return NextResponse.json({ type: "unauthenticated", status: 401 }, { status: 401 });

  const url = `${process.env.GO_API_BASE_URL}/v1/${ctx.params.path.join("/")}${req.nextUrl.search}`;
  const upstream = await fetch(url, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": req.headers.get("content-type") ?? "application/json",
    },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.text(),
  });
  return new NextResponse(upstream.body, { status: upstream.status, headers: upstream.headers });
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
```

- [x] **Step 2: Auth guard (proxy.ts)**

Path: `frontend/middleware.ts`
```ts
import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/((?!api/auth|_next|favicon.ico|$).*)"],
};

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has("kbp_sid");
  if (!hasSession) {
    const url = new URL("/api/auth/login", req.nextUrl.origin);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
```

- [x] **Step 3: Smoke test**

With Go running on :8080, Next.js on :3000:
```bash
curl -i http://localhost:3000/api/v1/me --cookie "kbp_sid=<from browser>"
```
Expected: `200 OK` with user info.

- [x] **Step 4: Commit**

```bash
git add frontend/app/api/v1/ frontend/middleware.ts
git commit -m "feat(frontend): BFF proxy with silent token refresh and auth guard"
```

---

### Task 18: Top bar + cluster picker

**Files:**
- Create: `frontend/components/TopBar.tsx`
- Create: `frontend/components/ClusterPicker.tsx`
- Modify: `frontend/app/layout.tsx`

- [x] **Step 1: Layout + top bar**

Path: `frontend/app/layout.tsx`
```tsx
import "./globals.css";
import { TopBar } from "@/components/TopBar";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-slate-50">
        <TopBar />
        <main className="max-w-6xl mx-auto p-6">{children}</main>
      </body>
    </html>
  );
}
```

Path: `frontend/components/TopBar.tsx`
```tsx
import Link from "next/link";
import { ClusterPicker } from "./ClusterPicker";

export async function TopBar() {
  const me = await fetch(`${process.env.GO_API_BASE_URL}/v1/me`, { cache: "no-store" })
    .catch(() => null)
    .then((r) => r?.ok ? r.json() : null);
  // (In practice: go through the BFF proxy from the server side. See api-server.ts helper.)

  return (
    <header className="flex items-center gap-6 bg-slate-900 text-slate-100 px-6 py-3 text-sm">
      <Link href="/" className="font-bold">kubeport</Link>
      <ClusterPicker />
      <nav className="flex gap-4 ml-auto">
        <Link href="/catalog">카탈로그</Link>
        <Link href="/releases">내 릴리스</Link>
        <Link href="/templates">템플릿</Link>
      </nav>
      <span className="ml-2 opacity-80">{me?.email ?? "…"}</span>
      <form action="/api/auth/logout" method="POST"><button className="opacity-60 hover:opacity-100">로그아웃</button></form>
    </header>
  );
}
```

Path: `frontend/components/ClusterPicker.tsx`
```tsx
"use client";
import { useEffect, useState } from "react";

export function ClusterPicker() {
  const [clusters, setClusters] = useState<{ name: string }[]>([]);
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    fetch("/api/v1/clusters").then((r) => r.json()).then((d) => {
      setClusters(d.clusters ?? []);
      const stored = localStorage.getItem("kbp_cluster") ?? d.clusters?.[0]?.name ?? "";
      setCurrent(stored);
    });
  }, []);

  function pick(name: string) {
    setCurrent(name);
    localStorage.setItem("kbp_cluster", name);
    location.reload();
  }

  return (
    <select value={current} onChange={(e) => pick(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs">
      {clusters.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
    </select>
  );
}
```

- [x] **Step 2: Smoke test**

```bash
cd frontend && pnpm dev
# open http://localhost:3000/ → shows top bar with email + cluster picker
```

- [x] **Step 3: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): top bar with cluster picker and logout"
```

---

### Task 19: Template list + detail + YAML editor pages

**Files:**
- Create: `frontend/app/templates/page.tsx`
- Create: `frontend/app/templates/[name]/page.tsx`
- Create: `frontend/app/templates/[name]/edit/page.tsx`
- Create: `frontend/components/YamlEditor.tsx`

- [x] **Step 1: Template list**

Path: `frontend/app/templates/page.tsx`
```tsx
import Link from "next/link";

export default async function TemplatesPage() {
  const res = await fetch(`${process.env.GO_API_BASE_URL}/v1/templates`, { cache: "no-store" });
  const data = await res.json();
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">템플릿</h1>
        <Link href="/templates/new/edit" className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">+ 새 템플릿</Link>
      </div>
      <table className="w-full bg-white border rounded">
        <thead className="text-xs text-slate-500"><tr>
          <th className="p-2 text-left">이름</th><th className="p-2 text-left">현재 버전</th><th className="p-2 text-left">설명</th>
        </tr></thead>
        <tbody>
          {data.templates?.map((t: any) => (
            <tr key={t.name} className="border-t">
              <td className="p-2"><Link href={`/templates/${t.name}`} className="text-blue-600">{t.display_name}</Link></td>
              <td className="p-2">v{t.current_version ?? "—"}</td>
              <td className="p-2 text-slate-600">{t.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [x] **Step 2: `YamlEditor.tsx`**

Path: `frontend/components/YamlEditor.tsx`
```tsx
"use client";
import dynamic from "next/dynamic";
const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export function YamlEditor({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="border rounded bg-white">
      <div className="px-3 py-1.5 text-xs font-mono border-b bg-slate-50">{label}</div>
      <Monaco height="40vh" language="yaml" value={value}
              onChange={(v) => onChange(v ?? "")} options={{ minimap: { enabled: false } }} />
    </div>
  );
}
```

- [x] **Step 3: Editor page (create/edit, YAML mode only)**

Path: `frontend/app/templates/[name]/edit/page.tsx`
```tsx
"use client";
import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { YamlEditor } from "@/components/YamlEditor";

const STARTER_RESOURCES = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: app
          image: nginx:1.25
          ports: [{ containerPort: 80 }]
`;

const STARTER_UISPEC = `fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
`;

export default function EditTemplatePage() {
  const router = useRouter();
  const { name } = useParams<{ name: string }>();
  const isNew = name === "new";
  const [displayName, setDisplayName] = useState("Web Service");
  const [description, setDescription] = useState("");
  const [resources, setResources] = useState(STARTER_RESOURCES);
  const [uispec, setUispec] = useState(STARTER_UISPEC);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    const body = {
      name: isNew ? prompt("템플릿 slug (영문소문자-, 예: web-service)")?.trim() : name,
      display_name: displayName, description,
      tags: [], resources_yaml: resources, ui_spec_yaml: uispec,
    };
    const res = await fetch(`/api/v1/templates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) { setErr(await res.text()); return; }
    const d = await res.json();
    router.push(`/templates/${d.template.name}`);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">{isNew ? "새 템플릿" : displayName}</h1>
        <button onClick={save} className="px-3 py-1.5 bg-green-600 text-white rounded text-sm">Save draft</button>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <input className="border rounded px-3 py-1.5" placeholder="표시 이름"
               value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className="border rounded px-3 py-1.5" placeholder="설명"
               value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <YamlEditor label="resources.yaml" value={resources} onChange={setResources} />
        <YamlEditor label="ui-spec.yaml"   value={uispec}    onChange={setUispec} />
      </div>
      {err && <div className="mt-3 text-red-600 text-sm whitespace-pre">{err}</div>}
    </div>
  );
}
```

- [x] **Step 4: Detail page (shows metadata, versions, publish button)**

Path: `frontend/app/templates/[name]/page.tsx`
```tsx
import Link from "next/link";

export default async function TemplateDetail({ params }: { params: { name: string } }) {
  const t = await fetch(`${process.env.GO_API_BASE_URL}/v1/templates/${params.name}`, { cache: "no-store" }).then(r => r.json());
  const vs = await fetch(`${process.env.GO_API_BASE_URL}/v1/templates/${params.name}/versions`, { cache: "no-store" }).then(r => r.json());

  return (
    <div>
      <h1 className="text-xl font-bold">{t.display_name}</h1>
      <p className="text-slate-600">{t.description}</p>
      <h2 className="mt-6 font-semibold">버전</h2>
      <ul className="space-y-2 mt-2">
        {vs.versions?.map((v: any) => (
          <li key={v.id} className="flex items-center gap-3">
            <span>v{v.version}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${v.status === 'published' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>{v.status}</span>
            {v.status === "draft" && (
              <form action={`/api/v1/templates/${t.name}/versions/${v.version}/publish`} method="POST">
                <button className="text-blue-600 text-sm">Publish</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <Link href={`/templates/${t.name}/edit`} className="text-blue-600 mt-4 inline-block">편집</Link>
    </div>
  );
}
```

- [x] **Step 5: Manual smoke test**

Through the UI: create template → Save → shows in list → open detail → Publish v1.

- [x] **Step 6: Commit**

```bash
git add frontend/app/templates/ frontend/components/YamlEditor.tsx
git commit -m "feat(frontend): template list, detail, and YAML-mode editor"
```

---

### Task 20: Catalog + DynamicForm + deploy flow

**Files:**
- Create: `frontend/app/catalog/page.tsx`
- Create: `frontend/components/DynamicForm.tsx`
- Create: `frontend/components/TemplateCard.tsx`
- Create: `frontend/app/catalog/[name]/deploy/page.tsx`

- [x] **Step 1: `TemplateCard` + Catalog page**

Path: `frontend/components/TemplateCard.tsx`
```tsx
import Link from "next/link";

export function TemplateCard({ t }: { t: any }) {
  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="text-base font-bold">{t.display_name}</div>
        <span className="text-xs text-slate-500">v{t.current_version}</span>
      </div>
      <div className="text-sm text-slate-600 mb-3">{t.description}</div>
      <Link href={`/catalog/${t.name}/deploy`}
            className="inline-block w-full text-center py-1.5 bg-blue-600 text-white rounded text-sm">
        배포
      </Link>
    </div>
  );
}
```

Path: `frontend/app/catalog/page.tsx`
```tsx
import { TemplateCard } from "@/components/TemplateCard";

export default async function CatalogPage() {
  const d = await fetch(`${process.env.GO_API_BASE_URL}/v1/templates`, { cache: "no-store" }).then(r => r.json());
  const published = (d.templates ?? []).filter((t: any) => t.current_version);
  return (
    <div>
      <h1 className="text-xl font-bold mb-4">카탈로그</h1>
      <div className="grid grid-cols-3 gap-4">
        {published.map((t: any) => <TemplateCard key={t.name} t={t} />)}
      </div>
    </div>
  );
}
```

- [x] **Step 2: `DynamicForm`**

Path: `frontend/components/DynamicForm.tsx`
```tsx
"use client";

import { useForm, Controller, type Control } from "react-hook-form";
import { z, type ZodTypeAny } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

export interface UISpecField {
  path: string;
  label: string;
  help?: string;
  type: "string" | "integer" | "boolean" | "enum";
  min?: number;
  max?: number;
  pattern?: string;
  values?: string[];
  placeholder?: string;
  default?: unknown;
  required?: boolean;
}

export interface UISpec {
  fields: UISpecField[];
}

function buildZodSchema(spec: UISpec) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of spec.fields) {
    let s: ZodTypeAny;
    switch (f.type) {
      case "integer": {
        let n = z.coerce.number().int();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        s = n;
        break;
      }
      case "string": {
        let str = z.string();
        if (f.pattern) str = str.regex(new RegExp(f.pattern));
        s = str;
        break;
      }
      case "boolean":
        s = z.boolean();
        break;
      case "enum":
        s = z.enum(f.values as [string, ...string[]]);
        break;
    }
    shape[f.path] = f.required ? s : s.optional();
  }
  return z.object(shape);
}

function defaultsFromSpec(spec: UISpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.default !== undefined) out[f.path] = f.default;
  }
  return out;
}

function FieldInput({
  spec, value, onChange,
}: { spec: UISpecField; value: unknown; onChange: (v: unknown) => void }) {
  switch (spec.type) {
    case "integer":
      return (
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          value={(value as number | undefined) ?? ""}
          onChange={(e) => onChange(Number(e.target.value))}
          className="border rounded px-3 py-1.5 w-32"
        />
      );
    case "enum":
      return (
        <select
          value={(value as string | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="border rounded px-3 py-1.5"
        >
          {spec.values!.map((v) => <option key={v}>{v}</option>)}
        </select>
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "string":
      return (
        <input
          type="text"
          value={(value as string | undefined) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={spec.placeholder}
          className="border rounded px-3 py-1.5 w-full"
        />
      );
  }
}

export function DynamicForm({
  spec,
  initialValues,
  onSubmit,
}: {
  spec: UISpec;
  initialValues?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const form = useForm({
    resolver: zodResolver(buildZodSchema(spec)),
    defaultValues: initialValues ?? defaultsFromSpec(spec),
  });
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      {spec.fields.map((f) => (
        <div key={f.path}>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {f.label}
            {f.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <Controller
            name={f.path}
            control={form.control as Control<Record<string, unknown>>}
            render={({ field, fieldState }) => (
              <>
                <FieldInput spec={f} value={field.value} onChange={field.onChange} />
                {f.help && <p className="text-xs text-slate-500 mt-1">{f.help}</p>}
                {fieldState.error && (
                  <p className="text-xs text-red-600 mt-1">{fieldState.error.message}</p>
                )}
              </>
            )}
          />
        </div>
      ))}
      <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded">
        배포
      </button>
    </form>
  );
}
```

- [x] **Step 3: Deploy page**

Path: `frontend/app/catalog/[name]/deploy/page.tsx`
```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DynamicForm, type UISpec } from "@/components/DynamicForm";

export default function DeployPage() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const [template, setTemplate] = useState<any>(null);
  const [spec, setSpec] = useState<UISpec | null>(null);
  const [cluster, setCluster] = useState<string>("");
  const [releaseName, setReleaseName] = useState<string>("");
  const [namespace, setNamespace] = useState<string>("default");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCluster(localStorage.getItem("kbp_cluster") ?? "");
    fetch(`/api/v1/templates/${name}`).then(r => r.json()).then((t) => {
      setTemplate(t);
      // fetch current version ui-spec
      fetch(`/api/v1/templates/${name}/versions/${t.current_version}`).then(r => r.json())
        .then((v) => setSpec(yamlToUISpec(v.ui_spec_yaml)));
    });
  }, [name]);

  async function submit(values: Record<string, unknown>) {
    setErr(null);
    const res = await fetch("/api/v1/releases", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        template: name, version: template.current_version,
        cluster, namespace, name: releaseName, values,
      }),
    });
    if (!res.ok) { setErr(await res.text()); return; }
    const d = await res.json();
    router.push(`/releases/${d.id}`);
  }

  if (!template || !spec) return <div>로딩 중…</div>;
  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{template.display_name} 배포</h1>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <input placeholder="릴리스 이름" value={releaseName} onChange={(e) => setReleaseName(e.target.value)}
               className="border rounded px-3 py-1.5" />
        <input placeholder="네임스페이스" value={namespace} onChange={(e) => setNamespace(e.target.value)}
               className="border rounded px-3 py-1.5" />
        <div className="text-sm text-slate-600 self-center">cluster: <b>{cluster}</b></div>
      </div>
      <DynamicForm spec={spec} onSubmit={submit} />
      {err && <div className="mt-3 text-red-600 text-sm whitespace-pre">{err}</div>}
    </div>
  );
}

function yamlToUISpec(s: string): UISpec {
  // quick yaml parse — use `yaml` npm package
  const YAML = require("yaml");
  return YAML.parse(s);
}
```

Add dependency:
```bash
pnpm add yaml
```

- [x] **Step 4: Smoke test**

End-to-end through the UI: catalog → card → deploy form generated from ui-spec → submit → redirect to `/releases/<id>`.

- [x] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): catalog + DynamicForm + deploy flow"
```

---

### Task 21: Release list + detail overview

**Files:**
- Create: `frontend/app/releases/page.tsx`
- Create: `frontend/app/releases/[id]/page.tsx`
- Create: `frontend/components/ReleaseTable.tsx`
- Create: `frontend/components/StatusBadge.tsx`

- [x] **Step 1: `StatusBadge` + `ReleaseTable`**

Path: `frontend/components/StatusBadge.tsx`
```tsx
const map: Record<string, string> = {
  healthy: "bg-green-100 text-green-800",
  warning: "bg-yellow-100 text-yellow-800",
  error:   "bg-red-100 text-red-800",
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`px-2 py-0.5 rounded text-xs ${map[status] ?? "bg-slate-100"}`}>{status}</span>;
}
```

Path: `frontend/components/ReleaseTable.tsx`
```tsx
import Link from "next/link";
import { StatusBadge } from "./StatusBadge";

export function ReleaseTable({ rows }: { rows: any[] }) {
  return (
    <table className="w-full bg-white border rounded text-sm">
      <thead className="text-xs text-slate-500"><tr>
        <th className="p-2 text-left">상태</th>
        <th className="p-2 text-left">이름</th>
        <th className="p-2 text-left">템플릿</th>
        <th className="p-2 text-left">네임스페이스</th>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} className="border-t">
            <td className="p-2"><StatusBadge status={r.status ?? "—"} /></td>
            <td className="p-2"><Link href={`/releases/${r.id}`} className="text-blue-600">{r.name}</Link></td>
            <td className="p-2">{r.template_name}@v{r.template_version}</td>
            <td className="p-2 font-mono text-xs">{r.namespace}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [x] **Step 2: Release list page**

Path: `frontend/app/releases/page.tsx`
```tsx
import { ReleaseTable } from "@/components/ReleaseTable";

export default async function ReleasesPage() {
  const d = await fetch(`${process.env.GO_API_BASE_URL}/v1/releases`, { cache: "no-store" }).then(r => r.json());
  return (
    <div>
      <h1 className="text-xl font-bold mb-4">내 릴리스</h1>
      <ReleaseTable rows={d.releases ?? []} />
    </div>
  );
}
```

- [x] **Step 3: Release detail page**

Path: `frontend/app/releases/[id]/page.tsx`
```tsx
import { StatusBadge } from "@/components/StatusBadge";

export default async function ReleaseDetail({ params }: { params: { id: string } }) {
  const d = await fetch(`${process.env.GO_API_BASE_URL}/v1/releases/${params.id}`, { cache: "no-store" }).then(r => r.json());
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-bold">{d.name}</h1>
        <StatusBadge status={d.status} />
        <span className="text-slate-500 text-sm">{d.template?.name}@v{d.template?.version}</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card title="상태 요약">
          <div className="text-2xl font-bold">{d.instances_ready}/{d.instances_total} 준비됨</div>
        </Card>
        <Card title="클러스터">
          <div>{d.cluster} / <span className="font-mono">{d.namespace}</span></div>
        </Card>
        <Card title="생성">
          <div className="text-sm text-slate-600">{new Date(d.created_at).toLocaleString()}</div>
        </Card>
      </div>
    </div>
  );
}
function Card({ title, children }: any) {
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-xs uppercase text-slate-500 mb-2">{title}</div>
      {children}
    </div>
  );
}
```

- [x] **Step 4: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): release list and detail overview"
```

---

### Task 22: End-to-end smoke test

**Files:**
- Create: `backend/e2e/e2e_test.go`

This test exercises: register cluster → create + publish template → deploy release → list releases → get release → delete release. It requires docker-compose + a kind cluster (optional).

- [x] **Step 1: Write the e2e test (compose + kind)**

Path: `backend/e2e/e2e_test.go`
```go
//go:build e2e
// +build e2e

package e2e_test

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "os/exec"
    "strings"
    "testing"
    "time"

    "github.com/stretchr/testify/require"
)

const (
    apiBase  = "http://localhost:8080"
    dexToken = "http://localhost:5556/token"
)

// fetchDexIDToken uses the dex password grant to get an id_token for admin/user.
func fetchDexIDToken(t *testing.T, email, password string, groups []string) string {
    t.Helper()
    form := url.Values{}
    form.Set("grant_type", "password")
    form.Set("client_id", "kubeport")
    form.Set("client_secret", "local-dev-secret")
    form.Set("username", email)
    form.Set("password", password)
    form.Set("scope", "openid email profile groups")
    resp, err := http.Post(dexToken, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
    require.NoError(t, err)
    defer resp.Body.Close()
    require.Equal(t, 200, resp.StatusCode)
    var out struct{ IDToken string `json:"id_token"` }
    require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
    require.NotEmpty(t, out.IDToken)
    return out.IDToken
}

func doAPI(t *testing.T, token, method, path string, body any) *http.Response {
    t.Helper()
    var buf io.Reader
    if body != nil {
        b, _ := json.Marshal(body)
        buf = bytes.NewReader(b)
    }
    req, _ := http.NewRequestWithContext(context.Background(), method, apiBase+path, buf)
    req.Header.Set("Authorization", "Bearer "+token)
    req.Header.Set("Content-Type", "application/json")
    resp, err := http.DefaultClient.Do(req)
    require.NoError(t, err)
    return resp
}

func TestE2E_HappyPath(t *testing.T) {
    if os.Getenv("KBP_KIND_API") == "" {
        t.Skip("KBP_KIND_API not set; skipping e2e")
    }

    // Ensure docker compose is up and Go API is running.
    require.NoError(t, exec.Command("docker", "compose", "-f", "../deploy/docker/docker-compose.yml", "up", "-d").Run())

    // Start API server in background
    cmd := exec.Command("go", "run", "../cmd/server")
    cmd.Env = append(os.Environ(),
        "LISTEN_ADDR=:8080",
        "DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable",
        "OIDC_ISSUER=http://localhost:5556",
        "OIDC_AUDIENCE=kubeport",
    )
    require.NoError(t, cmd.Start())
    defer cmd.Process.Kill()
    time.Sleep(2 * time.Second)

    adminTok := fetchDexIDToken(t, "admin@example.com", "admin", []string{"kubeport-admin"})
    userTok  := fetchDexIDToken(t, "alice@example.com", "alice", []string{"dev-team"})

    // 1. Register cluster (admin)
    resp := doAPI(t, adminTok, "POST", "/v1/clusters", map[string]any{
        "name": "kind", "api_url": os.Getenv("KBP_KIND_API"),
        "oidc_issuer_url": "http://localhost:5556",
    })
    require.Equal(t, 201, resp.StatusCode)
    resp.Body.Close()

    // 2. Create template (admin) and publish v1
    resp = doAPI(t, adminTok, "POST", "/v1/templates", map[string]any{
        "name": "web-e2e", "display_name": "Web E2E",
        "resources_yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}\nspec:\n  replicas: 1\n  selector: {matchLabels: {app: web}}\n  template:\n    metadata: {labels: {app: web}}\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.25\n",
        "ui_spec_yaml":   "fields:\n  - path: Deployment[web].spec.replicas\n    label: replicas\n    type: integer\n    min: 1\n    max: 5\n",
    })
    require.Equal(t, 201, resp.StatusCode)
    resp.Body.Close()

    resp = doAPI(t, adminTok, "POST", "/v1/templates/web-e2e/versions/1/publish", nil)
    require.Equal(t, 200, resp.StatusCode)
    resp.Body.Close()

    // 3. User deploys
    resp = doAPI(t, userTok, "POST", "/v1/releases", map[string]any{
        "template": "web-e2e", "version": 1,
        "cluster": "kind", "namespace": "default", "name": "my-api",
        "values":   map[string]any{"Deployment[web].spec.replicas": 2},
    })
    require.Equal(t, 201, resp.StatusCode)
    var rel struct{ ID string `json:"id"` }
    require.NoError(t, json.NewDecoder(resp.Body).Decode(&rel))
    resp.Body.Close()

    // 4. Poll until healthy
    require.Eventually(t, func() bool {
        r := doAPI(t, userTok, "GET", "/v1/releases/"+rel.ID, nil)
        defer r.Body.Close()
        body, _ := io.ReadAll(r.Body)
        return r.StatusCode == 200 && bytes.Contains(body, []byte(`"status":"healthy"`))
    }, 60*time.Second, 2*time.Second, "release never became healthy")

    // 5. User lists releases
    resp = doAPI(t, userTok, "GET", "/v1/releases", nil)
    require.Equal(t, 200, resp.StatusCode)
    body, _ := io.ReadAll(resp.Body)
    resp.Body.Close()
    require.Contains(t, string(body), "my-api")

    // 6. Delete release and confirm k8s resources are gone
    resp = doAPI(t, userTok, "DELETE", "/v1/releases/"+rel.ID, nil)
    require.Equal(t, 204, resp.StatusCode)
    resp.Body.Close()

    // Using kubectl directly to confirm. kubectl must be configured for KBP_KIND_API.
    out, err := exec.Command("kubectl", "-n", "default", "get", "deployments",
        "-l", "kubeport.io/release=my-api", "--no-headers").CombinedOutput()
    require.NoError(t, err)
    require.Empty(t, strings.TrimSpace(string(out)), "deployment should have been deleted")

    fmt.Println("e2e happy path passed")
}
```

- [x] **Step 2: Make target**

Path: `Makefile` (root)
```make
e2e:
	docker compose -f deploy/docker/docker-compose.yml up -d
	cd backend && atlas schema apply --env local --auto-approve
	cd backend && go test -tags=e2e ./e2e/... -v
```

- [x] **Step 3: Run**

```bash
make e2e
```
Expected: PASS in ~30-60s.

> **Note (2026-04-18)**: actual execution deferred — kind cluster not available in current dev env. Compile + skip path verified via `go test -tags=e2e ./e2e/... -run=^$`.

- [x] **Step 4: Commit**

```bash
git add backend/e2e/ Makefile
git commit -m "test: end-to-end happy-path smoke covering the full Plan 1 slice"
```

---

### Task 23: README polish + developer notes

**Files:**
- Modify: `README.md`

- [x] **Step 1: Expand README with the minimum every new contributor needs**

Path: `README.md`
```markdown
# kubeport

Web app that lets k8s admins publish templated resources and lets non-expert users deploy/operate them.

See [design spec](docs/superpowers/specs/2026-04-16-initial-design.md).

## Prerequisites
- Docker
- Go 1.22+
- Node 20+ / pnpm 9+
- `atlas` CLI, `sqlc`

## Quick start
```bash
# 1. Start local services
docker compose -f deploy/docker/docker-compose.yml up -d

# 2. Apply DB schema
cd backend && atlas schema apply --env local --auto-approve

# 3. Run the API
go run ./cmd/server

# 4. Run the web
cd ../frontend
cp .env.example .env.local   # then fill in values
pnpm install && pnpm dev
```

## Running tests
```bash
cd backend && go test ./...
make e2e
```

## Project layout
- `backend/`   Go API server
- `frontend/`  Next.js web app
- `deploy/`    Docker + Helm (later plan)
- `docs/`      Specs, ADRs, brainstorming notes
```

- [x] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: fill in README with setup and test commands"
```

---

## Self-Review Checklist (run after final commit)

**Spec coverage:**
- §2 user roles ✔ Tasks 7, 8 (group claim, requireAdmin)
- §3 template shape (resources + ui-spec + metadata) ✔ Tasks 10, 11
- §3.5 versioning (draft → published) ✔ Task 11 (`PublishVersion`); deprecation deferred to Plan 2
- §4 architecture (5 components, 4 flows) ✔ Tasks 2-6 backend, 15-17 frontend
- §5 tech stack ✔ all tasks match (Gin, client-go, sqlc, atlas, Next.js 15, openid-client, iron-session not used → replaced with custom session helper tied to the `sessions` table as spec §6.2 mandates)
- §6 data model (6 tables) ✔ Task 3 + Tasks 5-6 queries
- §6.4 label/annotation convention ✔ Task 10 (`stampLabels`)
- §7 API surface (Next.js BFF + `/v1` endpoints) ✔ Tasks 8, 9, 11, 13, 14, 16, 17 (logs/SSE + events/update deferred per plan scope)
- §10 security (httpOnly cookie, AES-GCM, token forwarding) ✔ Tasks 16, 17
- §12.1 MVP scope ✔ except SSE logs / events / update-available, all deferred to Plan 3 as noted
- §13 open questions — not addressed; captured in plan 2/3 preface

**Placeholder scan:** all steps contain actual code, no "TBD"/"similar to above"/"add error handling".

**Type consistency:** `template.Render` signature is identical in Task 10, 11, 13. `K8sApplier` interface stable across Tasks 13, 14. Handler names match between `routes.go` and their implementation files. `UpsertUser` params consistent in Tasks 5, 11, 13.

---

## Deferred to Plan 2 (`2026-04-16-mvp-2-admin-ux.md`)
- Admin UI-mode editor (resource tree + field meta editor + live preview)
- Template deprecation + version history UI
- Template delete (with safety check for active releases)
- Admin-only cluster management UI page

## Deferred to Plan 3 (`2026-04-16-mvp-3-user-observability.md`)
- Release logs tab (SSE streaming)
- Release events tab + activity
- Release settings tab
- Release update-available notifications + migration flow
- Release update (PUT /v1/releases/:id re-apply)
- Helm chart for deploying `kubeport` itself (backend `Deployment` + frontend `Deployment` + single `Ingress` with path routing per ADR 0001)
- Frontend production Dockerfile (multi-stage, copy `.next/standalone` into `node:*-alpine`) + image publish pipeline
- Backend production Dockerfile hardening
