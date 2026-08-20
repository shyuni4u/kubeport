# kubeport MVP Phase 2 — Admin UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Plan 2: admins can build templates in a schema-driven **UI mode** (no YAML typing), own them via teams with editor/viewer roles, deprecate versions to stop new deploys while existing releases keep running, and see a flat version history. User experience from Plan 1 (catalog, deploy, release detail) stays unchanged except deprecated versions are filtered out.

**Architecture:** All backend additions are layered on Plan 1's Go API. OpenAPI v3 is fetched per request from the target cluster using the user's id_token (Plan 1 principle preserved) and cached in an in-process LRU keyed by `(cluster, user, groupVersion)`. The UI editor keeps state as a JSON tree on the client; every keystroke (debounced) calls a stateless `POST /v1/templates/preview` endpoint whose server-side Go serializer produces the authoritative `resources.yaml` + `ui_spec.yaml`. Teams are a new DB concept layered onto the existing `templates` row via `owning_team_id`; releases stay exactly as Plan 1 defined.

**Tech Stack:** Unchanged from Plan 1 plus `github.com/hashicorp/golang-lru/v2` (OpenAPI cache). Frontend adds no new dependencies — `@monaco-editor/react`, `react-hook-form`, `zod`, `yaml`, shadcn/ui already in place.

**Scope (this plan):**
- New DB tables `teams`, `team_memberships`; new columns `templates.owning_team_id`, `template_versions.authoring_mode`, `template_versions.ui_state_json`; `template_versions.status` extended to include `deprecated`.
- Backend API: team CRUD + membership, OpenAPI v3 proxy with cache + refresh, template preview, authoring_mode-aware template create, deprecate/undeprecate, release reject on deprecated.
- Frontend: `/admin/teams` pages, schema-driven UI editor (`SchemaTree`, `FieldInspector`, `KindPicker`, `YamlPreview`), UI-mode create + edit pages, template detail enhancements (deprecate button, legacy-mode badge).
- Go e2e test covering the admin-as-editor path: team creation → member add → UI-mode template create → publish → deploy as member → deprecate → new deploy rejected.
- Playwright UI regression suite for team admin, UI editor, and deprecate flow (runs against the same local stack).

**Out of scope (later plans):** YAML-mode editor UI (Plan 1's POST path stays as programmatic entry), diff view between versions, audit log, team invitation workflow, release team ownership, team-scoped catalog visibility, Helm chart import, Git-backed templates.

**Reference spec:** [docs/superpowers/specs/2026-04-18-plan2-admin-ux-design.md](../specs/2026-04-18-plan2-admin-ux-design.md) v0.2 — every design decision below cites section numbers from the spec. Brainstorming record: [docs/brainstorming-summary.md §12](../../brainstorming-summary.md).

---

## File Structure

Additive — Plan 1 files stay. New and modified files below.

```
kubeport/
├── backend/
│   ├── internal/
│   │   ├── api/
│   │   │   ├── teams.go                  (new — team CRUD + membership handlers)
│   │   │   ├── teams_test.go             (new)
│   │   │   ├── openapi_proxy.go          (new — /v1/clusters/:name/openapi[/:gv] with LRU cache)
│   │   │   ├── openapi_proxy_test.go     (new)
│   │   │   ├── permissions.go            (new — ensureTemplateEditor helper)
│   │   │   ├── preview.go                (new — POST /v1/templates/preview)
│   │   │   ├── preview_test.go           (new)
│   │   │   ├── templates.go              (modify — authoring_mode, owning_team_id, deprecate)
│   │   │   ├── templates_test.go         (modify)
│   │   │   ├── releases.go               (modify — reject deprecated)
│   │   │   └── routes.go                 (modify — new routes)
│   │   ├── store/
│   │   │   └── queries/
│   │   │       ├── teams.sql             (new)
│   │   │       └── templates.sql         (modify — owning_team_id, status extension, deprecate mutations)
│   │   ├── template/
│   │   │   ├── uimode.go                 (new — UIModeTemplate → YAML serializer)
│   │   │   └── uimode_test.go            (new)
│   │   └── config/config.go              (modify — KBP_OPENAPI_CACHE_MAX)
│   ├── migrations/
│   │   └── schema.hcl                    (modify — add teams, team_memberships, new columns)
│   └── e2e/e2e_test.go                   (modify — extend with Plan 2 flow)
├── frontend/
│   ├── app/
│   │   ├── admin/
│   │   │   └── teams/
│   │   │       ├── page.tsx              (new — team list + create)
│   │   │       └── [id]/page.tsx         (new — team detail + members)
│   │   ├── templates/
│   │   │   ├── new/page.tsx              (new — UI mode create)
│   │   │   └── [name]/
│   │   │       ├── page.tsx              (modify — deprecate button, legacy badge)
│   │   │       └── versions/
│   │   │           └── [v]/edit/page.tsx (new — UI mode edit for authoring_mode='ui')
│   │   └── catalog/page.tsx              (modify — hide deprecated versions)
│   ├── components/
│   │   ├── SchemaTree.tsx                (new)
│   │   ├── FieldInspector.tsx            (new)
│   │   ├── KindPicker.tsx                (new)
│   │   └── YamlPreview.tsx               (new)
│   └── lib/
│       └── openapi.ts                    (new — parse k8s OpenAPI v3 into a field tree)
└── docs/
    └── (README updated in Task 23)
```

**Responsibilities (hard boundaries):**
- `internal/template/uimode.go` — pure function `SerializeUIMode(ui UIModeTemplate) (resourcesYAML, uiSpecYAML string, err error)`. No HTTP, no DB.
- `internal/api/openapi_proxy.go` — fetch + cache. No parsing (raw bytes passed through to client).
- `internal/api/permissions.go` — `ensureTemplateEditor(c *gin.Context, name string) (store.Template, bool)`. Returns false after writing the error response.
- `frontend/lib/openapi.ts` — pure TS: input is the k8s OpenAPI v3 JSON, output is a typed schema tree the React components render. No fetching.
- `frontend/components/SchemaTree.tsx` — renders the tree, bubbles field selection up via callback. No state except expanded/collapsed.
- `frontend/components/FieldInspector.tsx` — form for a single field (fixed vs exposed + ui-spec entry fields).
- `frontend/components/YamlPreview.tsx` — Monaco read-only. Debounce + POST `/v1/templates/preview`.

---

## Prerequisites

All Plan 1 prereqs plus:
- A running kind cluster (or any k8s ≥ 1.24 that publishes `/openapi/v3`) for OpenAPI proxy integration tests.
- `docs/local-e2e.md` setup already working — Plan 2 assumes you can log in and hit the Go API locally.

---

## Tasks

### Task 1: Extend schema — teams, team_memberships, new template columns

**Files:**
- Modify: `backend/migrations/schema.hcl`

- [ ] **Step 1: Add `teams` table**

Append to `backend/migrations/schema.hcl`:
```hcl
table "teams" {
  schema = schema.public
  column "id"           { type = uuid null = false default = sql("gen_random_uuid()") }
  column "name"         { type = text null = false }
  column "display_name" { type = text }
  column "created_at"   { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  index "teams_name_uq" { columns = [column.name] unique = true }
}
```

- [ ] **Step 2: Add `team_memberships` table**

```hcl
table "team_memberships" {
  schema = schema.public
  column "user_id"    { type = uuid null = false }
  column "team_id"    { type = uuid null = false }
  column "role"       { type = text null = false }   # "editor" | "viewer"
  column "created_at" { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.user_id, column.team_id] }
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
  index "tm_team" { columns = [column.team_id] }
}
```

- [ ] **Step 3: Add `owning_team_id` to `templates`**

Inside the existing `table "templates"` block:
```hcl
column "owning_team_id" { type = uuid null = true }
foreign_key "t_team_fk" {
  columns     = [column.owning_team_id]
  ref_columns = [table.teams.column.id]
  on_delete   = SET_NULL
}
```

- [ ] **Step 4: Add `authoring_mode` + `ui_state_json` to `template_versions`**

Inside the existing `table "template_versions"` block:
```hcl
column "authoring_mode" { type = text  null = false default = "yaml" }
column "ui_state_json"  { type = jsonb null = true }
```

No change needed for `status` — it's already `text`; the value `'deprecated'` is a new string the API layer validates.

- [ ] **Step 5: Apply and verify**

```bash
cd backend && atlas schema apply --env local --auto-approve
```
Expected: atlas prints the new CREATE TABLE + ALTER TABLE statements and exits 0.

```bash
docker exec docker-postgres-1 psql -U kubeport -d kubeport -c '\d teams'
docker exec docker-postgres-1 psql -U kubeport -d kubeport -c '\d team_memberships'
docker exec docker-postgres-1 psql -U kubeport -d kubeport -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'template_versions' AND column_name IN ('authoring_mode','ui_state_json');"
```
Expected: both tables exist; both new columns listed.

- [ ] **Step 6: Regenerate sqlc source-of-truth schema.sql**

```bash
cd backend/migrations && atlas schema inspect --env local --format '{{ sql . }}' > schema.sql
```

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/
git commit -m "feat(backend): schema for teams, team_memberships, template authoring_mode"
```

---

### Task 2: sqlc queries for teams and memberships

**Files:**
- Create: `backend/internal/store/queries/teams.sql`
- Modify: `backend/internal/store/queries/templates.sql`
- Test: `backend/internal/store/store_test.go` (extend)

- [ ] **Step 1: Write team queries**

Path: `backend/internal/store/queries/teams.sql`
```sql
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
```

- [ ] **Step 2: Extend template queries**

Append to `backend/internal/store/queries/templates.sql`:
```sql
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
```

Keep the existing `InsertTemplate`, `InsertTemplateVersion`, `PublishTemplateVersion` — Plan 1 callers still use them; the new `V2` variants accept the extra columns.

- [ ] **Step 3: Regenerate sqlc**

```bash
cd backend && sqlc generate
```
Expected: new functions `InsertTeam`, `ListTeams`, `ListTeamsForUser`, `GetTeamByID`, `GetTeamByName`, `DeleteTeam`, `InsertTeamMembership`, `ListTeamMembers`, `DeleteTeamMembership`, `GetTeamMembership`, `CountTemplatesForTeam`, `InsertTemplateV2`, `InsertTemplateVersionV2`, `SetTemplateVersionStatus` in `internal/store/*.sql.go`. Build should succeed.

```bash
cd backend && go build ./...
```

- [ ] **Step 4: Append store test for team flow**

Append to `backend/internal/store/store_test.go`:
```go
func TestInsertTeamAndMembership(t *testing.T) {
    ctx := context.Background()
    s, err := store.NewStore(ctx, testDSN(t))
    require.NoError(t, err)
    defer s.Close()

    u, err := s.UpsertUser(ctx, store.UpsertUserParams{
        OidcSubject: "team-owner-" + time.Now().Format("150405.000000"),
        Email:       pgText("owner@example.com"),
        DisplayName: pgText("Owner"),
    })
    require.NoError(t, err)

    team, err := s.InsertTeam(ctx, store.InsertTeamParams{
        Name:        "team-" + time.Now().Format("150405.000000"),
        DisplayName: pgText("Team X"),
    })
    require.NoError(t, err)
    require.NotZero(t, team.ID)

    mem, err := s.InsertTeamMembership(ctx, store.InsertTeamMembershipParams{
        UserID: u.ID,
        TeamID: team.ID,
        Role:   "editor",
    })
    require.NoError(t, err)
    require.Equal(t, "editor", mem.Role)

    members, err := s.ListTeamMembers(ctx, team.ID)
    require.NoError(t, err)
    require.Len(t, members, 1)
    require.Equal(t, "owner@example.com", members[0].Email.String)
}
```

- [ ] **Step 5: Run tests**

```bash
cd backend && go test ./internal/store/...
```
Expected: PASS (compose must be running).

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat(backend): sqlc queries for teams + team_memberships + V2 template inserts"
```

---

### Task 3: Team CRUD API — list + create

**Files:**
- Create: `backend/internal/api/teams.go`
- Create: `backend/internal/api/teams_test.go`
- Modify: `backend/internal/api/routes.go`

- [ ] **Step 1: Write the test**

Path: `backend/internal/api/teams_test.go`
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
    "kubeport/internal/config"
)

func TestTeams_Create_RequiresAdmin(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: testStore(t)})
    req := httptest.NewRequest(http.MethodPost, "/v1/teams",
        bytes.NewReader([]byte(`{"name":"plat-`+randSuffix()+`","display_name":"Platform"}`)))
    req.Header.Set("Authorization", "Bearer x")
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusForbidden, w.Code)
}

func TestTeams_Create_AdminSucceeds(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: testStore(t)})
    name := "plat-" + randSuffix()
    req := httptest.NewRequest(http.MethodPost, "/v1/teams",
        bytes.NewReader([]byte(`{"name":"`+name+`","display_name":"Platform"}`)))
    req.Header.Set("Authorization", "Bearer x")
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusCreated, w.Code)

    var got map[string]any
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
    require.Equal(t, name, got["name"])
    require.NotEmpty(t, got["id"])
}

func TestTeams_List_NonAdminSeesOnlyTheirTeams(t *testing.T) {
    s := testStore(t)

    // Seed one team as admin; alice is not added.
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
    teamName := "visible-" + randSuffix()
    w := do(t, adminR, http.MethodPost, "/v1/teams",
        bytes.NewReader([]byte(`{"name":"`+teamName+`","display_name":"Vis"}`)))
    require.Equal(t, http.StatusCreated, w.Code)

    // Alice lists teams — empty (she's not a member of any).
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
    w = do(t, userR, http.MethodGet, "/v1/teams", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.NotContains(t, w.Body.String(), teamName)
}
```

- [ ] **Step 2: Run — expect failure**

```bash
cd backend && go test ./internal/api/... -run Teams
```
Expected: FAIL — `/v1/teams` routes don't exist.

- [ ] **Step 3: Implement handler**

Path: `backend/internal/api/teams.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"
    "github.com/google/uuid"

    "kubeport/internal/auth"
    "kubeport/internal/store"
)

type createTeamReq struct {
    Name        string `json:"name" binding:"required,min=1"`
    DisplayName string `json:"display_name"`
}

func (h *Handlers) CreateTeam(c *gin.Context) {
    var r createTeamReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    team, err := h.deps.Store.InsertTeam(c, store.InsertTeamParams{
        Name:        r.Name,
        DisplayName: pgText(r.DisplayName),
    })
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", err.Error())
        return
    }
    c.JSON(http.StatusCreated, team)
}

func (h *Handlers) ListTeams(c *gin.Context) {
    u, _ := auth.UserFrom(c.Request.Context())

    if isKubeportAdmin(u) {
        all, err := h.deps.Store.ListTeams(c)
        if err != nil {
            writeError(c, http.StatusInternalServerError, "internal", err.Error())
            return
        }
        c.JSON(http.StatusOK, gin.H{"teams": all})
        return
    }

    user, err := h.deps.Store.UpsertUser(c, store.UpsertUserParams{
        OidcSubject: u.Subject,
        Email:       pgText(u.Email),
        DisplayName: pgText(u.Name),
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    mine, err := h.deps.Store.ListTeamsForUser(c, user.ID)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"teams": mine})
}

// isKubeportAdmin centralises the group check used from multiple handlers.
func isKubeportAdmin(u auth.RequestUser) bool {
    for _, g := range u.Groups {
        if g == "kubeport-admin" {
            return true
        }
    }
    return false
}

// parseUUIDParam extracts a UUID path param or writes 400 and returns false.
func parseUUIDParam(c *gin.Context, name string) (uuid.UUID, bool) {
    id, err := uuid.Parse(c.Param(name))
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", name+" must be a uuid")
        return uuid.Nil, false
    }
    return id, true
}
```

- [ ] **Step 4: Wire routes**

In `backend/internal/api/routes.go`, add inside the `v := r.Group("/v1", requireAuth(deps.Verifier))` block:

```go
v.GET("/teams", h.ListTeams)
v.POST("/teams", requireAdmin(), h.CreateTeam)
```

- [ ] **Step 5: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Teams
```

- [ ] **Step 6: Commit**

```bash
git add backend/internal/api/
git commit -m "feat(backend): team create/list endpoints (admin creates, user sees own)"
```

---

### Task 4: Team membership API — list, add, remove

**Files:**
- Modify: `backend/internal/api/teams.go`
- Modify: `backend/internal/api/teams_test.go`
- Modify: `backend/internal/api/routes.go`

- [ ] **Step 1: Write the tests**

Append to `backend/internal/api/teams_test.go`:
```go
func TestTeams_Members_AdminAddsByEmail(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

    // Alice must exist in users table (stubVerifier always returns alice@example.com).
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})
    w := do(t, userR, http.MethodGet, "/v1/me", nil)
    require.Equal(t, http.StatusOK, w.Code)
    // hit any admin-gated endpoint to UpsertUser for admin@example.com too (already done by adminVerifier in ListTeams above)

    // Create team and add alice as editor.
    teamName := "mem-" + randSuffix()
    w = do(t, adminR, http.MethodPost, "/v1/teams",
        bytes.NewReader([]byte(`{"name":"`+teamName+`"}`)))
    require.Equal(t, http.StatusCreated, w.Code)
    var tm map[string]any
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &tm))
    tid := tm["id"].(string)

    w = do(t, adminR, http.MethodPost, "/v1/teams/"+tid+"/members",
        bytes.NewReader([]byte(`{"email":"alice@example.com","role":"editor"}`)))
    require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

    // Alice now sees the team.
    w = do(t, userR, http.MethodGet, "/v1/teams", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), teamName)
}

func TestTeams_Members_RemoveReverts(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

    _ = do(t, userR, http.MethodGet, "/v1/me", nil) // ensure alice exists

    teamName := "rem-" + randSuffix()
    w := do(t, adminR, http.MethodPost, "/v1/teams",
        bytes.NewReader([]byte(`{"name":"`+teamName+`"}`)))
    require.Equal(t, http.StatusCreated, w.Code)
    var tm map[string]any
    _ = json.Unmarshal(w.Body.Bytes(), &tm)
    tid := tm["id"].(string)

    w = do(t, adminR, http.MethodPost, "/v1/teams/"+tid+"/members",
        bytes.NewReader([]byte(`{"email":"alice@example.com","role":"editor"}`)))
    require.Equal(t, http.StatusCreated, w.Code)

    // find alice's user_id via /v1/me (subject is in claims; we use email lookup in the handler, so hit members)
    w = do(t, adminR, http.MethodGet, "/v1/teams/"+tid+"/members", nil)
    require.Equal(t, http.StatusOK, w.Code)
    var lr struct {
        Members []struct {
            UserID string `json:"user_id"`
            Email  struct {
                String string `json:"String"`
                Valid  bool   `json:"Valid"`
            } `json:"email"`
        } `json:"members"`
    }
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &lr))
    require.Len(t, lr.Members, 1)
    uid := lr.Members[0].UserID

    w = do(t, adminR, http.MethodDelete, "/v1/teams/"+tid+"/members/"+uid, nil)
    require.Equal(t, http.StatusNoContent, w.Code)

    // Alice no longer sees it.
    w = do(t, userR, http.MethodGet, "/v1/teams", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.NotContains(t, w.Body.String(), teamName)
}
```

- [ ] **Step 2: Run — expect failure**

```bash
cd backend && go test ./internal/api/... -run TestTeams_Members
```
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement membership handlers**

Append to `backend/internal/api/teams.go`:
```go
type addMemberReq struct {
    Email string `json:"email" binding:"required,email"`
    Role  string `json:"role"  binding:"required,oneof=editor viewer"`
}

func (h *Handlers) ListTeamMembers(c *gin.Context) {
    tid, ok := parseUUIDParam(c, "id")
    if !ok {
        return
    }
    members, err := h.deps.Store.ListTeamMembers(c, tid)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"members": members})
}

func (h *Handlers) AddTeamMember(c *gin.Context) {
    tid, ok := parseUUIDParam(c, "id")
    if !ok {
        return
    }
    var r addMemberReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    target, err := h.deps.Store.GetUserByEmail(c, pgText(r.Email))
    if err != nil {
        writeError(c, http.StatusNotFound, "user-not-found",
            "user must have logged in at least once before being added to a team")
        return
    }
    m, err := h.deps.Store.InsertTeamMembership(c, store.InsertTeamMembershipParams{
        UserID: target.ID,
        TeamID: tid,
        Role:   r.Role,
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusCreated, m)
}

func (h *Handlers) RemoveTeamMember(c *gin.Context) {
    tid, ok := parseUUIDParam(c, "id")
    if !ok {
        return
    }
    uid, ok := parseUUIDParam(c, "user_id")
    if !ok {
        return
    }
    if err := h.deps.Store.DeleteTeamMembership(c, store.DeleteTeamMembershipParams{TeamID: tid, UserID: uid}); err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.Status(http.StatusNoContent)
}
```

- [ ] **Step 4: Add `GetUserByEmail` query**

Append to `backend/internal/store/queries/users.sql`:
```sql
-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;
```

```bash
cd backend && sqlc generate
```

- [ ] **Step 5: Wire routes**

In `backend/internal/api/routes.go` inside the `v` group:
```go
v.GET("/teams/:id/members", h.ListTeamMembers)
v.POST("/teams/:id/members", requireAdmin(), h.AddTeamMember)
v.DELETE("/teams/:id/members/:user_id", requireAdmin(), h.RemoveTeamMember)
```

- [ ] **Step 6: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run TestTeams
```

- [ ] **Step 7: Commit**

```bash
git add backend/
git commit -m "feat(backend): team membership add/list/remove (admin-gated, by email)"
```

---

### Task 5: Template editor permission helper

**Files:**
- Create: `backend/internal/api/permissions.go`
- Test: `backend/internal/api/permissions_test.go`

- [ ] **Step 1: Write the test**

Path: `backend/internal/api/permissions_test.go`
```go
package api_test

import (
    "bytes"
    "net/http"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/api"
    "kubeport/internal/config"
)

// global template (owning_team_id NULL): only admins can mutate.
func TestPermissions_GlobalTemplate_NonAdminDenied(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

    name := seedGlobalTemplate(t, adminR) // helper below

    w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusForbidden, w.Code)
}

// team template: team editors can mutate, viewers can't, non-members can't.
func TestPermissions_TeamTemplate_EditorAllowed(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

    // create team, add alice as editor.
    _ = do(t, userR, http.MethodGet, "/v1/me", nil)
    tid := createTeam(t, adminR, "team-"+randSuffix())
    addMember(t, adminR, tid, "alice@example.com", "editor")

    name := seedTemplateOwnedBy(t, adminR, tid) // helper
    publishV1(t, adminR, name)

    // editor alice deprecates successfully.
    w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusOK, w.Code)
}

func TestPermissions_TeamTemplate_ViewerDenied(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
    userR := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}, Store: s})

    _ = do(t, userR, http.MethodGet, "/v1/me", nil)
    tid := createTeam(t, adminR, "team-"+randSuffix())
    addMember(t, adminR, tid, "alice@example.com", "viewer")

    name := seedTemplateOwnedBy(t, adminR, tid)
    publishV1(t, adminR, name)

    w := do(t, userR, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusForbidden, w.Code)
}
```

The helpers `seedGlobalTemplate`, `seedTemplateOwnedBy`, `createTeam`, `addMember`, `publishV1` live in `testdata_test.go` — add them as small wrappers around `do(...)`. Each is ~5 lines.

- [ ] **Step 2: Implement the helper**

Path: `backend/internal/api/permissions.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/auth"
    "kubeport/internal/store"
)

// ensureTemplateEditor loads the template by name from the URL and writes a
// 403 response if the caller can't mutate it. Returns (template, true) when
// allowed, or (zero, false) when the response has already been written.
//
// Rules:
// - Global template (owning_team_id null): caller must be kubeport-admin.
// - Team template: caller must be a team editor OR kubeport-admin.
func (h *Handlers) ensureTemplateEditor(c *gin.Context, name string) (store.Template, bool) {
    tpl, err := h.deps.Store.GetTemplateByName(c, name)
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template "+name)
        return store.Template{}, false
    }
    u, _ := auth.UserFrom(c.Request.Context())

    if isKubeportAdmin(u) {
        return tpl, true
    }

    if !tpl.OwningTeamID.Valid {
        writeError(c, http.StatusForbidden, "rbac-denied", "global template requires kubeport-admin")
        return store.Template{}, false
    }

    user, err := h.deps.Store.UpsertUser(c, store.UpsertUserParams{
        OidcSubject: u.Subject,
        Email:       pgText(u.Email),
        DisplayName: pgText(u.Name),
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return store.Template{}, false
    }

    mem, err := h.deps.Store.GetTeamMembership(c, store.GetTeamMembershipParams{
        TeamID: tpl.OwningTeamID.UUID,
        UserID: user.ID,
    })
    if err != nil || mem.Role != "editor" {
        writeError(c, http.StatusForbidden, "rbac-denied", "team editor required")
        return store.Template{}, false
    }
    return tpl, true
}
```

(Imports: `net/http`, `github.com/gin-gonic/gin`, `kubeport/internal/auth`, `kubeport/internal/store`.)


- [ ] **Step 3: Run permission tests**

```bash
cd backend && go test ./internal/api/... -run Permissions
```

Task 11 (deprecate endpoint) wires this helper in for real. The permission tests exercise that wiring once both are in place, so Step 3 here passes only after Task 11; mark Task 5 test step as "FAIL (expected) — re-verified after Task 11".

- [ ] **Step 4: Commit**

```bash
git add backend/internal/api/permissions.go backend/internal/api/permissions_test.go backend/internal/api/testdata_test.go
git commit -m "feat(backend): template editor permission helper (global=admin, team=editor)"
```

---

### Task 6: OpenAPI v3 proxy — list groupversions + fetch one

**Files:**
- Create: `backend/internal/api/openapi_proxy.go`
- Create: `backend/internal/api/openapi_proxy_test.go`
- Modify: `backend/internal/api/routes.go`
- Modify: `backend/go.mod` (add `github.com/hashicorp/golang-lru/v2`)
- Modify: `backend/internal/config/config.go`

- [ ] **Step 1: Add LRU dependency**

```bash
cd backend && go get github.com/hashicorp/golang-lru/v2
```

- [ ] **Step 2: Add cache size config**

In `backend/internal/config/config.go`, add to the `Config` struct:
```go
OpenAPICacheMax int
```

In `backend/cmd/server/main.go`, in the `config.Config{...}` literal:
```go
OpenAPICacheMax: getenvInt("KBP_OPENAPI_CACHE_MAX", 64),
```

And helper:
```go
func getenvInt(k string, def int) int {
    if v := os.Getenv(k); v != "" {
        n, err := strconv.Atoi(v)
        if err == nil {
            return n
        }
    }
    return def
}
```

- [ ] **Step 3: Write the test**

Path: `backend/internal/api/openapi_proxy_test.go`
```go
//go:build integration
// +build integration

package api_test

import (
    "net/http"
    "net/http/httptest"
    "os"
    "testing"

    "github.com/stretchr/testify/require"

    "kubeport/internal/api"
    "kubeport/internal/config"
)

// These tests require a kind cluster reachable at KIND_API and a dex token.
// Run with: go test -tags=integration ./internal/api/...
func kindAvail(t *testing.T) (apiURL, caBundle, token string) {
    apiURL = os.Getenv("KIND_API")
    if apiURL == "" {
        t.Skip("KIND_API not set")
    }
    ca := os.Getenv("KIND_CA")
    if ca == "" {
        t.Skip("KIND_CA not set")
    }
    tok := os.Getenv("DEX_TOKEN")
    if tok == "" {
        t.Skip("DEX_TOKEN not set")
    }
    return apiURL, ca, tok
}

func TestOpenAPI_ListGroupVersions(t *testing.T) {
    apiURL, ca, tok := kindAvail(t)
    s := testStore(t)
    adminR := api.NewRouter(config.Config{OpenAPICacheMax: 32},
        api.Deps{Verifier: adminVerifier{}, Store: s})

    // register cluster
    regBody, _ := json.Marshal(map[string]any{
        "name": "kind-" + randSuffix(),
        "api_url": apiURL,
        "ca_bundle": ca,
        "oidc_issuer_url": "https://host.docker.internal:5556",
    })
    w := do(t, adminR, http.MethodPost, "/v1/clusters", bytes.NewReader(regBody))
    require.Equal(t, http.StatusCreated, w.Code)
    var cl map[string]any
    _ = json.Unmarshal(w.Body.Bytes(), &cl)

    // Inject dex token into adminVerifier context — for this integration test
    // the Authorization header value is forwarded by the proxy to k8s.
    req := httptest.NewRequest(http.MethodGet, "/v1/clusters/"+cl["name"].(string)+"/openapi", nil)
    req.Header.Set("Authorization", "Bearer "+tok)
    w = httptest.NewRecorder()
    adminR.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"paths":`)
    require.Contains(t, w.Body.String(), `apps/v1`)
}
```

- [ ] **Step 4: Run — expect FAIL**

```bash
cd backend && go test -tags=integration ./internal/api/... -run OpenAPI
```
Expected: FAIL — routes + handler missing. (Skipped if env vars missing; still compile-errors first.)

- [ ] **Step 5: Implement the proxy**

Path: `backend/internal/api/openapi_proxy.go`
```go
package api

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "io"
    "net/http"
    "net/url"
    "strings"
    "sync"
    "time"

    "github.com/gin-gonic/gin"
    lru "github.com/hashicorp/golang-lru/v2"

    "kubeport/internal/auth"
)

type openapiCacheKey struct {
    cluster string
    user    string // oidc subject
    gv      string // "" for the index, "apps/v1" etc. otherwise
}

type openapiCacheEntry struct {
    body      []byte
    storedAt  time.Time
    contentTy string
}

type openapiProxy struct {
    cache *lru.Cache[openapiCacheKey, openapiCacheEntry]
    mu    sync.Mutex
}

const openapiTTL = 60 * time.Minute

func newOpenAPIProxy(size int) *openapiProxy {
    if size <= 0 {
        size = 64
    }
    c, _ := lru.New[openapiCacheKey, openapiCacheEntry](size)
    return &openapiProxy{cache: c}
}

func (h *Handlers) GetOpenAPIIndex(c *gin.Context) {
    h.proxyOpenAPI(c, "")
}

func (h *Handlers) GetOpenAPIGroupVersion(c *gin.Context) {
    gv := strings.TrimPrefix(c.Param("gv"), "/")
    if gv == "" {
        writeError(c, http.StatusBadRequest, "validation-error", "gv required")
        return
    }
    h.proxyOpenAPI(c, gv)
}

func (h *Handlers) RefreshOpenAPI(c *gin.Context) {
    cluster := c.Param("name")
    u, _ := auth.UserFrom(c.Request.Context())
    h.openapi.mu.Lock()
    defer h.openapi.mu.Unlock()
    for _, k := range h.openapi.cache.Keys() {
        if k.cluster == cluster && k.user == u.Subject {
            h.openapi.cache.Remove(k)
        }
    }
    c.Status(http.StatusNoContent)
}

func (h *Handlers) proxyOpenAPI(c *gin.Context, gv string) {
    name := c.Param("name")
    cluster, err := h.deps.Store.GetClusterByName(c, name)
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "cluster "+name)
        return
    }
    u, _ := auth.UserFrom(c.Request.Context())

    key := openapiCacheKey{cluster: name, user: u.Subject, gv: gv}
    if e, ok := h.openapi.cache.Get(key); ok && time.Since(e.storedAt) < openapiTTL {
        c.Data(http.StatusOK, e.contentTy, e.body)
        return
    }

    upstreamPath := "/openapi/v3"
    if gv != "" {
        upstreamPath = "/openapi/v3/apis/" + gv
    }
    up, err := url.Parse(cluster.ApiUrl)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    up.Path = upstreamPath
    req, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, up.String(), nil)
    req.Header.Set("Authorization", "Bearer "+u.IDToken)
    req.Header.Set("Accept", "application/json")

    client := &http.Client{Transport: buildTransport(cluster.CaBundle.String)}
    resp, err := client.Do(req)
    if err != nil {
        writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
        return
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
        return
    }
    if resp.StatusCode >= 400 {
        writeError(c, resp.StatusCode, "k8s-error", string(body))
        return
    }

    ct := resp.Header.Get("Content-Type")
    if ct == "" {
        ct = "application/json"
    }
    h.openapi.cache.Add(key, openapiCacheEntry{body: body, storedAt: time.Now(), contentTy: ct})
    c.Data(http.StatusOK, ct, body)
}

func buildTransport(caBundle string) http.RoundTripper {
    t := http.DefaultTransport.(*http.Transport).Clone()
    if strings.TrimSpace(caBundle) == "" {
        t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
        return t
    }
    pool, err := x509.SystemCertPool()
    if err != nil || pool == nil {
        pool = x509.NewCertPool()
    }
    if ok := pool.AppendCertsFromPEM([]byte(caBundle)); !ok {
        t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
        return t
    }
    t.TLSClientConfig = &tls.Config{RootCAs: pool}
    return t
}
```

- [ ] **Step 6: Wire into `Handlers`**

In `backend/internal/api/routes.go`:

```go
type Handlers struct {
    deps    Deps
    openapi *openapiProxy
}

func NewRouter(cfg config.Config, deps Deps) *gin.Engine {
    r := gin.New()
    r.Use(gin.Recovery())
    r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })

    h := &Handlers{deps: deps, openapi: newOpenAPIProxy(cfg.OpenAPICacheMax)}
    v := r.Group("/v1", requireAuth(deps.Verifier))
    v.GET("/me", h.GetMe)
    v.GET("/clusters", h.ListClusters)
    v.POST("/clusters", requireAdmin(), h.CreateCluster)
    v.GET("/clusters/:name/openapi", h.GetOpenAPIIndex)
    v.GET("/clusters/:name/openapi/*gv", h.GetOpenAPIGroupVersion)
    v.POST("/clusters/:name/openapi/refresh", h.RefreshOpenAPI)
    // ... (plus existing template / release routes)
    return r
}
```

- [ ] **Step 7: Run integration test**

With compose up and a kind cluster registered (see `docs/local-e2e.md`):
```bash
export KIND_API="https://127.0.0.1:6443"
export KIND_CA="$(kubectl --context kind-kubeport config view --raw --minify --flatten -o json | jq -r '.clusters[0].cluster."certificate-authority-data"' | base64 -d)"
export DEX_TOKEN="$(curl -ks -X POST https://host.docker.internal:5556/token -d grant_type=password -d client_id=kubeport -d client_secret=local-dev-secret -d username=alice@example.com -d password=alice -d 'scope=openid email profile' | jq -r .id_token)"
cd backend && go test -tags=integration ./internal/api/... -run OpenAPI
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat(backend): OpenAPI v3 proxy with LRU cache (per cluster/user/gv)"
```

---

### Task 7: OpenAPI refresh endpoint UX wiring

The handler was implemented in Task 6; confirm it actually clears entries and is routed. Small sanity task.

**Files:**
- Test: `backend/internal/api/openapi_proxy_test.go` (extend)

- [ ] **Step 1: Write the test**

Append to `openapi_proxy_test.go`:
```go
func TestOpenAPI_Refresh_ClearsCache(t *testing.T) {
    apiURL, ca, tok := kindAvail(t)
    s := testStore(t)
    r := api.NewRouter(config.Config{OpenAPICacheMax: 32},
        api.Deps{Verifier: adminVerifier{}, Store: s})

    // register cluster
    regBody, _ := json.Marshal(map[string]any{
        "name": "kind-" + randSuffix(),
        "api_url": apiURL,
        "ca_bundle": ca,
        "oidc_issuer_url": "https://host.docker.internal:5556",
    })
    w := do(t, r, http.MethodPost, "/v1/clusters", bytes.NewReader(regBody))
    require.Equal(t, http.StatusCreated, w.Code)
    var cl map[string]any
    _ = json.Unmarshal(w.Body.Bytes(), &cl)
    name := cl["name"].(string)

    // Prime cache
    req := httptest.NewRequest(http.MethodGet, "/v1/clusters/"+name+"/openapi", nil)
    req.Header.Set("Authorization", "Bearer "+tok)
    w = httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)

    // Refresh
    req = httptest.NewRequest(http.MethodPost, "/v1/clusters/"+name+"/openapi/refresh", nil)
    req.Header.Set("Authorization", "Bearer "+tok)
    w = httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusNoContent, w.Code)

    // Next GET should repopulate (can't prove cache miss from outside easily; just ensure no error)
    req = httptest.NewRequest(http.MethodGet, "/v1/clusters/"+name+"/openapi", nil)
    req.Header.Set("Authorization", "Bearer "+tok)
    w = httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)
}
```

- [ ] **Step 2: Run**

```bash
cd backend && go test -tags=integration ./internal/api/... -run OpenAPI_Refresh
```

- [ ] **Step 3: Commit**

```bash
git add backend/
git commit -m "test(backend): refresh clears openapi cache and re-fetches"
```

---

### Task 8: UI-mode template → YAML serializer

**Files:**
- Create: `backend/internal/template/uimode.go`
- Create: `backend/internal/template/uimode_test.go`

- [ ] **Step 1: Write the test**

Path: `backend/internal/template/uimode_test.go`
```go
package template_test

import (
    "testing"

    "github.com/stretchr/testify/require"
    "gopkg.in/yaml.v3"

    "kubeport/internal/template"
)

func TestSerializeUIMode_FixedAndExposedFields(t *testing.T) {
    ui := template.UIModeTemplate{
        Resources: []template.UIResource{
            {
                APIVersion: "apps/v1", Kind: "Deployment", Name: "web",
                Fields: map[string]template.UIField{
                    "spec.replicas": {
                        Mode: "exposed",
                        UISpec: &template.UISpecEntry{
                            Label: "인스턴스 개수", Type: "integer", Min: intPtr(1), Max: intPtr(10), Default: 3, Required: true,
                        },
                    },
                    "spec.template.spec.containers[0].image": {
                        Mode:       "fixed",
                        FixedValue: "nginx:1.25",
                    },
                    "spec.template.spec.containers[0].name": {
                        Mode:       "fixed",
                        FixedValue: "app",
                    },
                },
            },
        },
    }

    resources, uispec, err := template.SerializeUIMode(ui)
    require.NoError(t, err)

    var dep map[string]any
    require.NoError(t, yaml.Unmarshal([]byte(resources), &dep))
    require.Equal(t, "apps/v1", dep["apiVersion"])
    require.Equal(t, "Deployment", dep["kind"])
    require.Equal(t, "web", dep["metadata"].(map[string]any)["name"])
    spec := dep["spec"].(map[string]any)
    require.Equal(t, 3, spec["replicas"]) // exposed default
    ctr := spec["template"].(map[string]any)["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)
    require.Equal(t, "nginx:1.25", ctr["image"])
    require.Equal(t, "app", ctr["name"])

    var parsed struct {
        Fields []template.UISpecEntry `yaml:"fields"`
    }
    require.NoError(t, yaml.Unmarshal([]byte(uispec), &parsed))
    require.Len(t, parsed.Fields, 1)
    require.Equal(t, "Deployment[web].spec.replicas", parsed.Fields[0].Path)
    require.Equal(t, "integer", parsed.Fields[0].Type)
}

func TestSerializeUIMode_NoExposedFields(t *testing.T) {
    ui := template.UIModeTemplate{
        Resources: []template.UIResource{
            {APIVersion: "v1", Kind: "ConfigMap", Name: "c", Fields: map[string]template.UIField{
                "data.k": {Mode: "fixed", FixedValue: "v"},
            }},
        },
    }
    _, uispec, err := template.SerializeUIMode(ui)
    require.NoError(t, err)
    require.Contains(t, uispec, "fields: []")
}

func intPtr(n int) *int { return &n }
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/template/... -run SerializeUIMode
```

- [ ] **Step 3: Implement**

Path: `backend/internal/template/uimode.go`
```go
package template

import (
    "bytes"
    "fmt"

    "gopkg.in/yaml.v3"
)

type UIModeTemplate struct {
    Resources []UIResource `json:"resources"`
}

type UIResource struct {
    APIVersion string             `json:"apiVersion"`
    Kind       string             `json:"kind"`
    Name       string             `json:"name"`
    Fields     map[string]UIField `json:"fields"` // key is JSON path within the resource (no Kind[name] prefix)
}

type UIField struct {
    Mode       string        `json:"mode"` // "fixed" | "exposed"
    FixedValue any           `json:"fixedValue,omitempty"`
    UISpec     *UISpecEntry  `json:"uiSpec,omitempty"`
}

// UISpecEntry mirrors template.Field from spec.go; kept separate for JSON-over-HTTP shape clarity.
type UISpecEntry struct {
    Path     string   `yaml:"path"     json:"path"`
    Label    string   `yaml:"label"    json:"label"`
    Help     string   `yaml:"help,omitempty"    json:"help,omitempty"`
    Type     string   `yaml:"type"     json:"type"`
    Min      *int     `yaml:"min,omitempty"     json:"min,omitempty"`
    Max      *int     `yaml:"max,omitempty"     json:"max,omitempty"`
    Pattern  string   `yaml:"pattern,omitempty" json:"pattern,omitempty"`
    Values   []string `yaml:"values,omitempty"  json:"values,omitempty"`
    Default  any      `yaml:"default,omitempty" json:"default,omitempty"`
    Required bool     `yaml:"required,omitempty" json:"required,omitempty"`
}

// SerializeUIMode converts the UI editor state into the resources + ui-spec
// YAML pair that the Plan 1 render pipeline understands.
func SerializeUIMode(ui UIModeTemplate) (resourcesYAML, uiSpecYAML string, err error) {
    var resBuf bytes.Buffer
    enc := yaml.NewEncoder(&resBuf)
    enc.SetIndent(2)

    var allFields []UISpecEntry

    for _, r := range ui.Resources {
        if r.APIVersion == "" || r.Kind == "" || r.Name == "" {
            return "", "", fmt.Errorf("resource missing apiVersion/kind/name")
        }
        doc := map[string]any{
            "apiVersion": r.APIVersion,
            "kind":       r.Kind,
            "metadata":   map[string]any{"name": r.Name},
        }
        for fpath, f := range r.Fields {
            switch f.Mode {
            case "fixed":
                if err := setJSONPathAbsolute(doc, fpath, f.FixedValue); err != nil {
                    return "", "", fmt.Errorf("resource %s/%s field %q: %w", r.Kind, r.Name, fpath, err)
                }
            case "exposed":
                if f.UISpec == nil {
                    return "", "", fmt.Errorf("exposed field %q missing ui-spec", fpath)
                }
                // Seed default into the rendered doc so partial renders look real.
                if f.UISpec.Default != nil {
                    if err := setJSONPathAbsolute(doc, fpath, f.UISpec.Default); err != nil {
                        return "", "", fmt.Errorf("default for %q: %w", fpath, err)
                    }
                }
                entry := *f.UISpec
                entry.Path = r.Kind + "[" + r.Name + "]." + fpath
                allFields = append(allFields, entry)
            default:
                return "", "", fmt.Errorf("unknown field mode %q", f.Mode)
            }
        }
        if err := enc.Encode(doc); err != nil {
            return "", "", err
        }
    }
    _ = enc.Close()

    if allFields == nil {
        allFields = []UISpecEntry{}
    }
    spec := map[string]any{"fields": allFields}
    uiBytes, err := yaml.Marshal(spec)
    if err != nil {
        return "", "", err
    }

    return resBuf.String(), string(uiBytes), nil
}

// setJSONPathAbsolute writes v at dotted/indexed path into obj, creating
// intermediate maps/arrays as needed. Distinct from render.go's setJSONPath
// because here path has no "Kind[name]." prefix — we're inside one document.
// Supports "a.b[0].c" grammar.
func setJSONPathAbsolute(obj map[string]any, path string, v any) error {
    // Delegate to an iterative walker similar to render.go's setInto.
    return setInto(obj, path, v)
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/template/... -run SerializeUIMode
```

If `setInto` is unexported inside the package, no import needed — both files live in `package template`.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/template/uimode.go backend/internal/template/uimode_test.go
git commit -m "feat(backend): UI-mode template serializer (state JSON → resources + ui-spec YAML)"
```

---

### Task 9: `POST /v1/templates/preview` — stateless live preview endpoint

**Files:**
- Create: `backend/internal/api/preview.go`
- Create: `backend/internal/api/preview_test.go`
- Modify: `backend/internal/api/routes.go`

- [ ] **Step 1: Write the test**

Path: `backend/internal/api/preview_test.go`
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
    "kubeport/internal/config"
)

func TestPreview_ReturnsResourcesAndUISpec(t *testing.T) {
    r := api.NewRouter(config.Config{}, api.Deps{Verifier: stubVerifier{}})
    body := map[string]any{
        "ui_state": map[string]any{
            "resources": []any{
                map[string]any{
                    "apiVersion": "apps/v1",
                    "kind":       "Deployment",
                    "name":       "web",
                    "fields": map[string]any{
                        "spec.replicas": map[string]any{
                            "mode": "exposed",
                            "uiSpec": map[string]any{
                                "label": "Replicas", "type": "integer", "default": 2, "required": true,
                            },
                        },
                    },
                },
            },
        },
    }
    raw, _ := json.Marshal(body)
    req := httptest.NewRequest(http.MethodPost, "/v1/templates/preview", bytes.NewReader(raw))
    req.Header.Set("Authorization", "Bearer x")
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)

    var got struct {
        ResourcesYAML string `json:"resources_yaml"`
        UISpecYAML    string `json:"ui_spec_yaml"`
    }
    require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
    require.Contains(t, got.ResourcesYAML, "kind: Deployment")
    require.Contains(t, got.ResourcesYAML, "replicas: 2") // default applied
    require.Contains(t, got.UISpecYAML, "Deployment[web].spec.replicas")
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/api/... -run Preview
```

- [ ] **Step 3: Implement handler**

Path: `backend/internal/api/preview.go`
```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/template"
)

type previewReq struct {
    UIState template.UIModeTemplate `json:"ui_state" binding:"required"`
}

func (h *Handlers) PreviewTemplate(c *gin.Context) {
    var r previewReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    resources, uispec, err := template.SerializeUIMode(r.UIState)
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{
        "resources_yaml": resources,
        "ui_spec_yaml":   uispec,
    })
}
```

- [ ] **Step 4: Wire route**

In `backend/internal/api/routes.go`, inside `v`:
```go
v.POST("/templates/preview", h.PreviewTemplate)
```

(Authenticated but not admin-gated — any logged-in user may preview.)

- [ ] **Step 5: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Preview
```

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat(backend): POST /v1/templates/preview (stateless UI state → YAML)"
```

---

### Task 10: Extend `POST /v1/templates` — `authoring_mode`, `owning_team_id`, `ui_state_json`

**Files:**
- Modify: `backend/internal/api/templates.go`
- Modify: `backend/internal/api/templates_test.go`

- [ ] **Step 1: Write the test**

Append to `backend/internal/api/templates_test.go`:
```go
func TestTemplates_Create_UIMode(t *testing.T) {
    r := newTestRouterAdmin(t)
    body := map[string]any{
        "name":         "web-" + randSuffix(),
        "display_name": "Web",
        "authoring_mode": "ui",
        "ui_state": map[string]any{
            "resources": []any{
                map[string]any{
                    "apiVersion": "apps/v1", "kind": "Deployment", "name": "web",
                    "fields": map[string]any{
                        "spec.replicas": map[string]any{
                            "mode": "exposed",
                            "uiSpec": map[string]any{"label": "Replicas", "type": "integer", "default": 1, "required": true},
                        },
                    },
                },
            },
        },
    }
    raw, _ := json.Marshal(body)
    w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
    require.Equal(t, http.StatusCreated, w.Code)
    require.Contains(t, w.Body.String(), `"authoring_mode":"ui"`)
    require.Contains(t, w.Body.String(), `"ui_state_json":`)
    require.Contains(t, w.Body.String(), "kind: Deployment") // resources_yaml populated
}

func TestTemplates_Create_ModeMismatch_Rejected(t *testing.T) {
    r := newTestRouterAdmin(t)
    // mode=ui but no ui_state
    body := `{"name":"x-` + randSuffix() + `","display_name":"X","authoring_mode":"ui","resources_yaml":"","ui_spec_yaml":""}`
    w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
    require.Equal(t, http.StatusBadRequest, w.Code)
    require.Contains(t, w.Body.String(), "ui_state")

    // mode=yaml but ui_state present
    body = `{"name":"y-` + randSuffix() + `","display_name":"Y","authoring_mode":"yaml","resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n","ui_spec_yaml":"fields: []\n","ui_state":{"resources":[]}}`
    w = do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
    require.Equal(t, http.StatusBadRequest, w.Code)
    require.Contains(t, w.Body.String(), "ui_state")
}

func TestTemplates_Create_OwningTeam(t *testing.T) {
    s := testStore(t)
    adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

    tid := createTeam(t, adminR, "team-"+randSuffix())

    body := `{"name":"t-` + randSuffix() + `","display_name":"T","authoring_mode":"yaml",
      "resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n",
      "ui_spec_yaml":"fields: []\n","owning_team_id":"` + tid + `"}`
    w := do(t, adminR, http.MethodPost, "/v1/templates", bytes.NewReader([]byte(body)))
    require.Equal(t, http.StatusCreated, w.Code)
    require.Contains(t, w.Body.String(), `"owning_team_id":"`+tid+`"`)
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/api/... -run Templates_Create
```

- [ ] **Step 3: Extend the request struct and handler**

In `backend/internal/api/templates.go`, replace the request struct and `CreateTemplate` with:

```go
type createTemplateReq struct {
    Name          string                  `json:"name"           binding:"required"`
    DisplayName   string                  `json:"display_name"   binding:"required"`
    Description   string                  `json:"description"`
    Tags          []string                `json:"tags"`
    AuthoringMode string                  `json:"authoring_mode" binding:"required,oneof=yaml ui"`
    OwningTeamID  string                  `json:"owning_team_id"` // uuid or ""

    // When mode=yaml:
    ResourcesYAML string                  `json:"resources_yaml"`
    UISpecYAML    string                  `json:"ui_spec_yaml"`

    // When mode=ui:
    UIState       *template.UIModeTemplate `json:"ui_state"`

    MetadataYAML  string                  `json:"metadata_yaml"`
}

func (h *Handlers) CreateTemplate(c *gin.Context) {
    var r createTemplateReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }

    // authoring_mode / payload consistency.
    switch r.AuthoringMode {
    case "ui":
        if r.UIState == nil {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui requires ui_state")
            return
        }
        if r.ResourcesYAML != "" || r.UISpecYAML != "" {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui must not send resources_yaml/ui_spec_yaml")
            return
        }
        res, spec, err := template.SerializeUIMode(*r.UIState)
        if err != nil {
            writeError(c, http.StatusBadRequest, "validation-error", err.Error())
            return
        }
        r.ResourcesYAML = res
        r.UISpecYAML = spec
    case "yaml":
        if r.UIState != nil {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml must not send ui_state")
            return
        }
        if r.ResourcesYAML == "" || r.UISpecYAML == "" {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml requires resources_yaml + ui_spec_yaml")
            return
        }
    }

    // render dry-run
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

    var owning pgtype.UUID
    if r.OwningTeamID != "" {
        parsed, err := uuid.Parse(r.OwningTeamID)
        if err != nil {
            writeError(c, http.StatusBadRequest, "validation-error", "owning_team_id must be a uuid")
            return
        }
        owning = pgtype.UUID{Bytes: parsed, Valid: true}
    }

    tpl, err := h.deps.Store.InsertTemplateV2(c, store.InsertTemplateV2Params{
        Name:         r.Name, DisplayName: r.DisplayName,
        Description:  pgText(r.Description), Tags: r.Tags,
        OwnerUserID:  user.ID,
        OwningTeamID: owning,
    })
    if err != nil {
        writeError(c, http.StatusConflict, "conflict", err.Error())
        return
    }

    var uiStateJSON pgtype.JSONB
    if r.UIState != nil {
        b, _ := json.Marshal(r.UIState)
        uiStateJSON = pgtype.JSONB{Bytes: b, Status: pgtype.Present}
    }

    ver, err := h.deps.Store.InsertTemplateVersionV2(c, store.InsertTemplateVersionV2Params{
        TemplateID:      tpl.ID, Version: 1,
        ResourcesYaml:   r.ResourcesYAML, UiSpecYaml: r.UISpecYAML,
        MetadataYaml:    pgText(r.MetadataYAML), Status: "draft",
        CreatedByUserID: user.ID,
        AuthoringMode:   r.AuthoringMode,
        UiStateJson:     uiStateJSON,
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }

    c.JSON(http.StatusCreated, gin.H{
        "template": tpl, "version": ver,
        "resources_yaml": r.ResourcesYAML, "ui_spec_yaml": r.UISpecYAML,
    })
}
```

Add necessary imports at the top: `encoding/json`, `github.com/google/uuid`, `github.com/jackc/pgx/v5/pgtype` (or whatever pgtype the generated code uses).

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Templates_Create
```

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): template create supports authoring_mode=ui + owning_team_id"
```

---

### Task 11: Deprecate / undeprecate endpoints

**Files:**
- Modify: `backend/internal/api/templates.go`
- Modify: `backend/internal/api/templates_test.go`
- Modify: `backend/internal/api/routes.go`

- [ ] **Step 1: Write the test**

Append to `backend/internal/api/templates_test.go`:
```go
func TestTemplates_Deprecate_RoundTrip(t *testing.T) {
    r := newTestRouterAdmin(t)
    name := seedGlobalTemplate(t, r)
    publishV1(t, r, name)

    w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"status":"deprecated"`)

    w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/undeprecate", nil)
    require.Equal(t, http.StatusOK, w.Code)
    require.Contains(t, w.Body.String(), `"status":"published"`)
}

func TestTemplates_Deprecate_OnlyFromPublished(t *testing.T) {
    r := newTestRouterAdmin(t)
    name := seedGlobalTemplate(t, r)
    // Don't publish — deprecating a draft must 409.
    w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusConflict, w.Code)
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/api/... -run Deprecate
```

- [ ] **Step 3: Implement handlers**

Append to `backend/internal/api/templates.go`:
```go
func (h *Handlers) DeprecateVersion(c *gin.Context) {
    _, ok := h.ensureTemplateEditor(c, c.Param("name"))
    if !ok {
        return
    }
    h.setVersionStatus(c, "published", "deprecated")
}

func (h *Handlers) UndeprecateVersion(c *gin.Context) {
    _, ok := h.ensureTemplateEditor(c, c.Param("name"))
    if !ok {
        return
    }
    h.setVersionStatus(c, "deprecated", "published")
}

func (h *Handlers) setVersionStatus(c *gin.Context, expected, newStatus string) {
    name := c.Param("name")
    vnum, err := strconv.Atoi(c.Param("v"))
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", "v must be an integer")
        return
    }
    tv, err := h.deps.Store.GetTemplateVersion(c, store.GetTemplateVersionParams{Name: name, Version: int32(vnum)})
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "template version")
        return
    }
    if tv.Status != expected {
        writeError(c, http.StatusConflict, "conflict",
            "version is "+tv.Status+", expected "+expected)
        return
    }
    updated, err := h.deps.Store.SetTemplateVersionStatus(c, store.SetTemplateVersionStatusParams{
        ID: tv.ID, Status: newStatus,
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, updated)
}
```

- [ ] **Step 4: Wire routes**

In `routes.go`:
```go
v.POST("/templates/:name/versions/:v/deprecate", h.DeprecateVersion)
v.POST("/templates/:name/versions/:v/undeprecate", h.UndeprecateVersion)
```

(Note: permission is checked inside the handler via `ensureTemplateEditor`, not by a separate middleware, so the route doesn't need `requireAdmin()`.)

- [ ] **Step 5: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Deprecate
```

Also re-run the Task 5 permission tests:
```bash
cd backend && go test ./internal/api/... -run Permissions
```
Expected: PASS now that deprecate endpoints exist.

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat(backend): deprecate/undeprecate template versions (editor-gated)"
```

---

### Task 12: Reject new releases against deprecated versions

**Files:**
- Modify: `backend/internal/api/releases.go`
- Modify: `backend/internal/api/releases_test.go`

- [ ] **Step 1: Write the test**

Append to `backend/internal/api/releases_test.go`:
```go
func TestReleases_Create_DeprecatedVersionRejected(t *testing.T) {
    applier := &fakeK8sApplier{}
    router := newTestRouterAdminWithK8s(t, applier)

    clusterName := seedCluster(t, router)
    tplName := seedPublishedTemplate(t, router)

    // deprecate v1
    w := do(t, router, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusOK, w.Code)

    body := []byte(`{"template":"` + tplName + `","version":1,"cluster":"` + clusterName + `","namespace":"default","name":"r-` + randSuffix() + `","values":{}}`)
    w = do(t, router, http.MethodPost, "/v1/releases", bytes.NewReader(body))
    require.Equal(t, http.StatusBadRequest, w.Code)
    require.Contains(t, w.Body.String(), "deprecated")
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/api/... -run Deprecated
```

- [ ] **Step 3: Implement rejection**

In `backend/internal/api/releases.go`, inside `CreateRelease` after fetching the template version and before applying, add:

```go
if tv.Status == "deprecated" {
    writeError(c, http.StatusBadRequest, "validation-error",
        "template "+req.Template+" v"+strconv.Itoa(int(tv.Version))+" is deprecated; pick a non-deprecated version")
    return
}
```

(`req.Template`, `tv`, `strconv` per existing handler code — add `strconv` import if missing.)

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run Deprecated
cd backend && go test ./internal/api/... -run Releases
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): reject release creation on deprecated template versions"
```

---

### Task 13: Frontend — `/admin/teams` + `/admin/teams/:id`

**Files:**
- Create: `frontend/app/admin/teams/page.tsx`
- Create: `frontend/app/admin/teams/[id]/page.tsx`

- [ ] **Step 1: Team list + create form (Server Component + Server Action)**

Path: `frontend/app/admin/teams/page.tsx`
```tsx
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { apiFetch } from "@/lib/api-server";

export default async function AdminTeamsPage() {
  const res = await apiFetch("/v1/teams");
  if (!res.ok) throw new Error(`팀 조회 실패: ${res.status} ${await res.text()}`);
  const { teams } = await res.json() as { teams: Array<{id:string; name:string; display_name:{String:string;Valid:boolean}}> };

  async function createTeam(formData: FormData) {
    "use server";
    const res = await apiFetch("/v1/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        display_name: formData.get("display_name"),
      }),
    });
    if (!res.ok) throw new Error(`팀 생성 실패: ${res.status} ${await res.text()}`);
    revalidatePath("/admin/teams");
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">팀 관리</h1>
      <form action={createTeam} className="flex gap-2 mb-6">
        <input name="name" placeholder="slug (예: platform)" className="border rounded px-3 py-1.5" required />
        <input name="display_name" placeholder="표시 이름" className="border rounded px-3 py-1.5" />
        <button className="px-4 py-1.5 bg-blue-600 text-white rounded">새 팀</button>
      </form>
      <ul className="space-y-2">
        {teams.map(t => (
          <li key={t.id}>
            <Link href={`/admin/teams/${t.id}`} className="text-blue-600">
              {t.display_name?.Valid ? t.display_name.String : t.name}
            </Link>
            <span className="text-xs text-slate-500 ml-2">{t.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Team detail + member management**

Path: `frontend/app/admin/teams/[id]/page.tsx`
```tsx
import { revalidatePath } from "next/cache";
import { apiFetch } from "@/lib/api-server";

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [membersRes, teamsRes] = await Promise.all([
    apiFetch(`/v1/teams/${id}/members`),
    apiFetch(`/v1/teams`),
  ]);
  if (!membersRes.ok) throw new Error(await membersRes.text());
  if (!teamsRes.ok) throw new Error(await teamsRes.text());
  const { members } = await membersRes.json() as {
    members: Array<{ user_id: string; role: string; email: {String:string;Valid:boolean}; user_display_name: {String:string;Valid:boolean} }>;
  };
  const { teams } = await teamsRes.json() as { teams: Array<{ id: string; name: string }> };
  const team = teams.find(t => t.id === id);

  async function addMember(formData: FormData) {
    "use server";
    const res = await apiFetch(`/v1/teams/${id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        role: formData.get("role"),
      }),
    });
    if (!res.ok) throw new Error(`멤버 추가 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/admin/teams/${id}`);
  }

  async function removeMember(formData: FormData) {
    "use server";
    const uid = formData.get("user_id");
    const res = await apiFetch(`/v1/teams/${id}/members/${uid}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`멤버 삭제 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/admin/teams/${id}`);
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{team?.name ?? id}</h1>

      <h2 className="font-semibold mb-2">멤버</h2>
      <table className="w-full bg-white border rounded text-sm mb-6">
        <thead className="text-xs text-slate-500">
          <tr><th className="p-2 text-left">이메일</th><th className="p-2 text-left">역할</th><th className="p-2"></th></tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr key={m.user_id} className="border-t">
              <td className="p-2">{m.email?.Valid ? m.email.String : m.user_id}</td>
              <td className="p-2">{m.role}</td>
              <td className="p-2">
                <form action={removeMember}>
                  <input type="hidden" name="user_id" value={m.user_id} />
                  <button className="text-red-600 text-sm">제거</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-semibold mb-2">새 멤버 추가</h2>
      <form action={addMember} className="flex gap-2">
        <input name="email" type="email" placeholder="이메일" required className="border rounded px-3 py-1.5" />
        <select name="role" className="border rounded px-3 py-1.5">
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="px-4 py-1.5 bg-blue-600 text-white rounded">추가</button>
      </form>
      <p className="text-xs text-slate-500 mt-2">대상 유저가 최소 한 번 이상 로그인한 적이 있어야 합니다.</p>
    </div>
  );
}
```

- [ ] **Step 3: Manual verification**

Start the stack per `docs/local-e2e.md`, then:
1. Log in as admin@example.com / admin
2. Visit http://localhost:3000/admin/teams
3. Create team `platform`
4. Open the team, try adding `alice@example.com` as editor — expect error if alice hasn't logged in yet
5. Log out, log in as alice, log out, log in as admin, retry add — expect success
6. Verify alice sees the team at `/admin/teams` too (logged in as alice)

- [ ] **Step 4: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): /admin/teams pages (list, create, members)"
```

---

### Task 14: Frontend — OpenAPI v3 parser utility

**Files:**
- Create: `frontend/lib/openapi.ts`
- Create: `frontend/lib/openapi.test.ts` (skip; Plan 1 convention defers frontend unit tests)

- [ ] **Step 1: Implement the parser**

Path: `frontend/lib/openapi.ts`
```ts
// OpenAPI v3 index (list of GroupVersions) response shape:
// { paths: { "apis/apps/v1": { serverRelativeURL: "/openapi/v3/apis/apps/v1" }, ... } }
// And a GroupVersion response like /openapi/v3/apis/apps/v1 has `components.schemas[kindName]`.

export interface OpenAPIIndex {
  paths: Record<string, { serverRelativeURL: string }>;
}

export interface OpenAPISchemaDoc {
  components?: { schemas?: Record<string, SchemaNode> };
}

export interface SchemaNode {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  format?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: Array<string | number>;
  $ref?: string;
  "x-kubernetes-group-version-kind"?: Array<{ group: string; version: string; kind: string }>;
}

/** Parse the OpenAPI index response into a list of GroupVersion strings. */
export function parseIndex(idx: OpenAPIIndex): string[] {
  return Object.keys(idx.paths ?? {})
    .filter(p => p.startsWith("apis/") || p === "api/v1")
    .map(p => p.replace(/^apis\//, "").replace(/^api\//, ""));
}

/** Find the top-level schema for a (group, version, kind) tuple. */
export function findKindSchema(doc: OpenAPISchemaDoc, group: string, version: string, kind: string): SchemaNode | null {
  const schemas = doc.components?.schemas ?? {};
  for (const name of Object.keys(schemas)) {
    const s = schemas[name];
    const gvks = s["x-kubernetes-group-version-kind"];
    if (!gvks) continue;
    for (const gvk of gvks) {
      if (gvk.group === group && gvk.version === version && gvk.kind === kind) {
        return resolveRefs(s, schemas);
      }
    }
  }
  return null;
}

/** Resolve all $ref entries inline (best-effort, cycles break into {$ref} leaves). */
export function resolveRefs(node: SchemaNode, schemas: Record<string, SchemaNode>, seen = new Set<string>()): SchemaNode {
  if (node.$ref) {
    const name = node.$ref.replace(/^#\/components\/schemas\//, "");
    if (seen.has(name)) return { type: "object", description: `(cycle: ${name})` };
    const target = schemas[name];
    if (!target) return node;
    return resolveRefs(target, schemas, new Set(seen).add(name));
  }
  const out: SchemaNode = { ...node };
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, resolveRefs(v, schemas, seen)]),
    );
  }
  if (node.items) out.items = resolveRefs(node.items, schemas, seen);
  return out;
}

export interface FlatField {
  path: string;     // e.g. "spec.replicas" or "spec.template.spec.containers[0].image"
  node: SchemaNode;
  required: boolean;
}

/** Walk a schema and yield every leaf-ish path (and every object node too).
 *  Array types yield a `[0]` path so the editor can set a first element. */
export function flattenSchema(root: SchemaNode, prefix = ""): FlatField[] {
  const out: FlatField[] = [];
  if (root.type === "object" && root.properties) {
    for (const [name, child] of Object.entries(root.properties)) {
      const p = prefix ? `${prefix}.${name}` : name;
      const required = (root.required ?? []).includes(name);
      out.push({ path: p, node: child, required });
      out.push(...flattenSchema(child, p));
    }
  } else if (root.type === "array" && root.items) {
    const p = `${prefix}[0]`;
    out.push({ path: p, node: root.items, required: false });
    out.push(...flattenSchema(root.items, p));
  }
  return out;
}
```

- [ ] **Step 2: Build passes typecheck**

```bash
cd frontend && pnpm exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/lib/openapi.ts
git commit -m "feat(frontend): OpenAPI v3 parser utility (index + schema tree flattener)"
```

---

### Task 15: Frontend — `SchemaTree`, `FieldInspector`, `KindPicker`

**Files:**
- Create: `frontend/components/KindPicker.tsx`
- Create: `frontend/components/SchemaTree.tsx`
- Create: `frontend/components/FieldInspector.tsx`

- [ ] **Step 1: `KindPicker`**

Path: `frontend/components/KindPicker.tsx`
```tsx
"use client";

import { useEffect, useState } from "react";
import { parseIndex, OpenAPIIndex } from "@/lib/openapi";

export interface KindRef {
  group: string;
  version: string;
  kind: string;
  gv: string; // "apps/v1" or "v1"
}

// Popular core kinds we surface in the picker without forcing the admin to dig.
// Users can still select any GroupVersion manually.
const FEATURED: KindRef[] = [
  { group: "apps", version: "v1", gv: "apps/v1", kind: "Deployment" },
  { group: "apps", version: "v1", gv: "apps/v1", kind: "StatefulSet" },
  { group: "",     version: "v1", gv: "v1",      kind: "Service" },
  { group: "",     version: "v1", gv: "v1",      kind: "ConfigMap" },
  { group: "",     version: "v1", gv: "v1",      kind: "Secret" },
  { group: "batch", version: "v1", gv: "batch/v1", kind: "Job" },
  { group: "batch", version: "v1", gv: "batch/v1", kind: "CronJob" },
];

export function KindPicker({
  cluster, onPick,
}: {
  cluster: string;
  onPick: (k: KindRef) => void;
}) {
  const [gvs, setGvs] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi`);
        if (!res.ok) throw new Error(`openapi index 조회 실패: ${res.status}`);
        const idx = await res.json() as OpenAPIIndex;
        setGvs(parseIndex(idx));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [cluster]);

  return (
    <div>
      <h3 className="font-semibold mb-2">빠른 선택</h3>
      <div className="flex flex-wrap gap-2 mb-4">
        {FEATURED.map(k => (
          <button
            key={k.gv + "/" + k.kind}
            onClick={() => onPick(k)}
            className="px-3 py-1 border rounded hover:bg-slate-100 text-sm"
          >
            {k.kind}
          </button>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-slate-700">전체 GroupVersion 목록 ({gvs.length})</summary>
        <div className="mt-2 max-h-64 overflow-auto text-xs font-mono">
          {err && <div className="text-red-600">{err}</div>}
          {gvs.map(gv => (
            <div key={gv} className="py-0.5">{gv}</div>
          ))}
        </div>
      </details>
    </div>
  );
}
```

- [ ] **Step 2: `SchemaTree`**

Path: `frontend/components/SchemaTree.tsx`
```tsx
"use client";

import { useState } from "react";
import { flattenSchema, SchemaNode } from "@/lib/openapi";

export function SchemaTree({
  schema, selectedPath, onSelect,
}: {
  schema: SchemaNode;
  selectedPath: string | null;
  onSelect: (path: string, node: SchemaNode) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["spec", "metadata"]));
  return (
    <ul className="text-sm font-mono">
      {renderNode("", schema, 0, expanded, setExpanded, selectedPath, onSelect)}
    </ul>
  );
}

function renderNode(
  path: string, node: SchemaNode, depth: number,
  expanded: Set<string>, setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>,
  selectedPath: string | null,
  onSelect: (path: string, node: SchemaNode) => void,
): React.ReactNode {
  if (node.type === "object" && node.properties) {
    return Object.entries(node.properties).map(([name, child]) => {
      const p = path ? `${path}.${name}` : name;
      const isExp = expanded.has(p);
      const hasKids = (child.type === "object" && !!child.properties) || (child.type === "array" && !!child.items);
      return (
        <li key={p} style={{ paddingLeft: depth * 12 }}>
          <span
            className={`cursor-pointer hover:bg-slate-100 px-1 rounded ${selectedPath === p ? "bg-blue-100" : ""}`}
            onClick={() => {
              onSelect(p, child);
              if (hasKids) {
                setExpanded(prev => {
                  const n = new Set(prev);
                  n.has(p) ? n.delete(p) : n.add(p);
                  return n;
                });
              }
            }}
          >
            {hasKids ? (isExp ? "▾ " : "▸ ") : "· "}
            {name}
            <span className="text-slate-400 ml-2">{child.type ?? "?"}</span>
          </span>
          {isExp && renderNode(p, child, depth + 1, expanded, setExpanded, selectedPath, onSelect)}
        </li>
      );
    });
  }
  if (node.type === "array" && node.items) {
    const p = `${path}[0]`;
    const isExp = expanded.has(p);
    return (
      <li style={{ paddingLeft: depth * 12 }}>
        <span
          className={`cursor-pointer hover:bg-slate-100 px-1 rounded ${selectedPath === p ? "bg-blue-100" : ""}`}
          onClick={() => {
            onSelect(p, node.items!);
            setExpanded(prev => {
              const n = new Set(prev);
              n.has(p) ? n.delete(p) : n.add(p);
              return n;
            });
          }}
        >
          {isExp ? "▾ " : "▸ "}[0]
          <span className="text-slate-400 ml-2">{node.items.type ?? "?"}</span>
        </span>
        {isExp && renderNode(p, node.items, depth + 1, expanded, setExpanded, selectedPath, onSelect)}
      </li>
    );
  }
  return null;
}
```

- [ ] **Step 3: `FieldInspector`**

Path: `frontend/components/FieldInspector.tsx`
```tsx
"use client";

import type { SchemaNode } from "@/lib/openapi";

export type UIField =
  | { mode: "fixed"; fixedValue: unknown }
  | {
      mode: "exposed";
      uiSpec: {
        label: string;
        type: "string" | "integer" | "boolean" | "enum";
        min?: number; max?: number;
        pattern?: string; values?: string[];
        default?: unknown; required?: boolean; help?: string;
      };
    };

export function FieldInspector({
  path, node, value, onChange, onClear,
}: {
  path: string;
  node: SchemaNode;
  value: UIField | undefined;
  onChange: (v: UIField) => void;
  onClear: () => void;
}) {
  const mode = value?.mode ?? null;
  const schemaType = mapSchemaType(node);

  return (
    <div className="border rounded p-4 text-sm">
      <div className="font-mono text-xs text-slate-500 mb-2">{path}</div>
      <div className="flex gap-2 mb-3">
        <button
          className={`px-2 py-1 rounded text-xs ${mode === "fixed" ? "bg-blue-600 text-white" : "bg-slate-100"}`}
          onClick={() => onChange({ mode: "fixed", fixedValue: defaultFor(schemaType) })}
        >값 고정</button>
        <button
          className={`px-2 py-1 rounded text-xs ${mode === "exposed" ? "bg-blue-600 text-white" : "bg-slate-100"}`}
          onClick={() => onChange({ mode: "exposed", uiSpec: { label: path, type: schemaType, required: false } })}
        >사용자 노출</button>
        {value && <button className="ml-auto text-xs text-red-600" onClick={onClear}>초기화</button>}
      </div>

      {value?.mode === "fixed" && (
        <div>
          <label className="block text-xs mb-1">값</label>
          <input
            className="border rounded px-2 py-1 w-full"
            value={String(value.fixedValue ?? "")}
            onChange={e => onChange({ mode: "fixed", fixedValue: coerce(e.target.value, schemaType) })}
          />
        </div>
      )}

      {value?.mode === "exposed" && (
        <div className="space-y-2">
          <Labeled label="라벨" v={value.uiSpec.label}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, label: x } })}/>
          <Labeled label="기본값" v={String(value.uiSpec.default ?? "")}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, default: coerce(x, value.uiSpec.type) } })}/>
          {value.uiSpec.type === "integer" && (
            <>
              <Labeled label="min" v={String(value.uiSpec.min ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, min: x ? Number(x) : undefined } })}/>
              <Labeled label="max" v={String(value.uiSpec.max ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, max: x ? Number(x) : undefined } })}/>
            </>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!value.uiSpec.required}
              onChange={e => onChange({ ...value, uiSpec: { ...value.uiSpec, required: e.target.checked } })}/>
            필수 입력
          </label>
        </div>
      )}
    </div>
  );
}

function Labeled({ label, v, onChange }: { label: string; v: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs mb-1">{label}</label>
      <input className="border rounded px-2 py-1 w-full" value={v} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function mapSchemaType(n: SchemaNode): "string" | "integer" | "boolean" | "enum" {
  if (n.enum) return "enum";
  if (n.type === "integer" || n.type === "number") return "integer";
  if (n.type === "boolean") return "boolean";
  return "string";
}

function defaultFor(t: "string" | "integer" | "boolean" | "enum"): unknown {
  if (t === "integer") return 0;
  if (t === "boolean") return false;
  return "";
}

function coerce(raw: string, t: "string" | "integer" | "boolean" | "enum"): unknown {
  if (t === "integer") return raw === "" ? undefined : Number(raw);
  if (t === "boolean") return raw === "true";
  return raw;
}
```

- [ ] **Step 4: Typecheck**

```bash
cd frontend && pnpm exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add frontend/components/
git commit -m "feat(frontend): schema tree + field inspector + kind picker components"
```

---

### Task 16: Frontend — `YamlPreview` via server `/preview`

**Files:**
- Create: `frontend/components/YamlPreview.tsx`

- [ ] **Step 1: Implement**

Path: `frontend/components/YamlPreview.tsx`
```tsx
"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export interface UIModeTemplate {
  resources: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    fields: Record<string, unknown>; // UIField values (shape: see FieldInspector.UIField)
  }>;
}

export function YamlPreview({ uiState }: { uiState: UIModeTemplate }) {
  const [resources, setResources] = useState("");
  const [uispec, setUISpec] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/v1/templates/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ui_state: uiState }),
        });
        if (!res.ok) {
          setErr(`${res.status}: ${await res.text()}`);
          return;
        }
        const d = await res.json() as { resources_yaml: string; ui_spec_yaml: string };
        setResources(d.resources_yaml);
        setUISpec(d.ui_spec_yaml);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [uiState]);

  return (
    <div className="space-y-3">
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      <div>
        <h3 className="text-xs font-semibold text-slate-500 mb-1">resources.yaml</h3>
        <Monaco height="240px" language="yaml" value={resources} options={{ readOnly: true, minimap: { enabled: false } }} />
      </div>
      <div>
        <h3 className="text-xs font-semibold text-slate-500 mb-1">ui-spec.yaml</h3>
        <Monaco height="160px" language="yaml" value={uispec} options={{ readOnly: true, minimap: { enabled: false } }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend && pnpm exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/YamlPreview.tsx
git commit -m "feat(frontend): YamlPreview that renders /preview output in Monaco"
```

---

### Task 17: Frontend — `/templates/new` UI mode page (ties 15+16 together)

**Files:**
- Modify: `frontend/app/templates/new/page.tsx` (create if absent in Plan 1)

- [ ] **Step 1: Write the page**

Path: `frontend/app/templates/new/page.tsx`
```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KindPicker, KindRef } from "@/components/KindPicker";
import { SchemaTree } from "@/components/SchemaTree";
import { FieldInspector, UIField } from "@/components/FieldInspector";
import { YamlPreview, UIModeTemplate } from "@/components/YamlPreview";
import { findKindSchema, OpenAPISchemaDoc, SchemaNode } from "@/lib/openapi";

interface EditedResource {
  gv: string;
  kind: string;
  name: string;          // metadata.name
  rootSchema: SchemaNode;
  fields: Record<string, UIField>;
}

export default function NewTemplatePage() {
  const router = useRouter();
  const [clusters, setClusters] = useState<Array<{ name: string }>>([]);
  const [cluster, setCluster] = useState<string>("");
  const [resources, setResources] = useState<EditedResource[]>([]);
  const [active, setActive] = useState<{ resIdx: number; path: string; node: SchemaNode } | null>(null);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [owningTeamId, setOwningTeamId] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [cRes, tRes] = await Promise.all([fetch("/api/v1/clusters"), fetch("/api/v1/teams")]);
      if (cRes.ok) {
        const d = await cRes.json() as { clusters: Array<{ name: string }> };
        setClusters(d.clusters);
        if (d.clusters[0]) setCluster(d.clusters[0].name);
      }
      if (tRes.ok) {
        const d = await tRes.json() as { teams: Array<{ id: string; name: string }> };
        setTeams(d.teams);
      }
    })();
  }, []);

  async function addKind(k: KindRef) {
    const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi/${k.gv}`);
    if (!res.ok) { setErr(await res.text()); return; }
    const doc = await res.json() as OpenAPISchemaDoc;
    const schema = findKindSchema(doc, k.group, k.version, k.kind);
    if (!schema) { setErr(`스키마 없음: ${k.kind}`); return; }
    setResources(prev => [...prev, {
      gv: k.gv, kind: k.kind,
      name: `${k.kind.toLowerCase()}-${prev.length + 1}`,
      rootSchema: schema,
      fields: {},
    }]);
  }

  const uiState: UIModeTemplate = useMemo(() => ({
    resources: resources.map(r => ({
      apiVersion: r.gv.includes("/") ? r.gv : (r.gv === "v1" ? "v1" : r.gv),
      kind: r.kind,
      name: r.name,
      fields: r.fields as unknown as Record<string, unknown>,
    })),
  }), [resources]);

  async function save() {
    setErr(null);
    const res = await fetch("/api/v1/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name, display_name: displayName,
        authoring_mode: "ui",
        owning_team_id: owningTeamId || undefined,
        ui_state: uiState,
      }),
    });
    if (!res.ok) { setErr(`${res.status}: ${await res.text()}`); return; }
    router.push("/templates");
  }

  if (clusters.length === 0) return <div>클러스터가 등록되어 있지 않습니다. 먼저 클러스터를 등록하세요.</div>;

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-3 space-y-4">
        <div>
          <label className="block text-xs mb-1">스키마 클러스터</label>
          <select value={cluster} onChange={e => setCluster(e.target.value)} className="border rounded px-2 py-1 w-full">
            {clusters.map(c => <option key={c.name}>{c.name}</option>)}
          </select>
        </div>
        <KindPicker cluster={cluster} onPick={addKind} />
        <hr />
        <div className="space-y-2">
          <h3 className="font-semibold">편집 중</h3>
          {resources.map((r, i) => (
            <div key={i} className="border rounded p-2">
              <input
                value={r.name}
                onChange={e => setResources(prev => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
                className="w-full border-b text-sm font-mono mb-2"
              />
              <div className="text-xs text-slate-500 mb-2">{r.gv} · {r.kind}</div>
              <SchemaTree
                schema={r.rootSchema}
                selectedPath={active?.resIdx === i ? active.path : null}
                onSelect={(p, n) => setActive({ resIdx: i, path: p, node: n })}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="col-span-5">
        <h2 className="font-semibold mb-3">필드 상세</h2>
        {active ? (
          <FieldInspector
            path={active.path}
            node={active.node}
            value={resources[active.resIdx].fields[active.path]}
            onChange={v => setResources(prev => prev.map((r, i) => i === active.resIdx
              ? { ...r, fields: { ...r.fields, [active.path]: v } }
              : r
            ))}
            onClear={() => setResources(prev => prev.map((r, i) => {
              if (i !== active.resIdx) return r;
              const { [active.path]: _, ...rest } = r.fields;
              return { ...r, fields: rest };
            }))}
          />
        ) : (
          <div className="text-slate-500 text-sm">왼쪽 트리에서 필드를 선택하세요.</div>
        )}

        <h2 className="font-semibold mt-6 mb-3">메타데이터</h2>
        <div className="space-y-2 mb-4">
          <input placeholder="템플릿 이름 (slug)" value={name} onChange={e => setName(e.target.value)}
            className="border rounded px-2 py-1 w-full" />
          <input placeholder="표시 이름" value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="border rounded px-2 py-1 w-full" />
          <select value={owningTeamId} onChange={e => setOwningTeamId(e.target.value)} className="border rounded px-2 py-1 w-full">
            <option value="">(글로벌 — admin 전용)</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <button onClick={save} className="px-4 py-2 bg-blue-600 text-white rounded">저장 (draft v1)</button>
        {err && <div className="text-red-600 text-sm whitespace-pre mt-2">{err}</div>}
      </div>

      <div className="col-span-4">
        <h2 className="font-semibold mb-3">프리뷰</h2>
        <YamlPreview uiState={uiState} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manual verification**

1. Log in as admin
2. Visit `/templates/new`
3. Pick "Deployment" → tree shows apps/v1 Deployment schema
4. Click `spec.replicas` → inspector lets you set "exposed" with ui-spec
5. Click `spec.template.spec.containers[0].image` → set "fixed" with `nginx:1.25`
6. Watch the right-side YAML preview update
7. Save → template appears at `/templates`
8. Publish v1 → deploy via `/catalog/<name>/deploy`

- [ ] **Step 3: Commit**

```bash
git add frontend/app/templates/new/page.tsx
git commit -m "feat(frontend): UI-mode /templates/new page (schema tree + inspector + preview)"
```

---

### Task 18: Backend `POST /v1/templates/:name/versions` + frontend edit-to-new-draft page

Spec §3.2: new versions of an existing template start from the UI state of the current published version (or empty for legacy YAML templates). This task ships both the backend endpoint and the frontend page that consumes it.

**Files:**
- Modify: `backend/internal/api/templates.go`
- Modify: `backend/internal/api/routes.go`
- Modify: `backend/internal/api/templates_test.go`
- Create: `frontend/app/templates/[name]/versions/[v]/edit/page.tsx`

- [ ] **Step 0: Write the backend test**

Append to `backend/internal/api/templates_test.go`:
```go
func TestTemplates_NewVersion_UIMode(t *testing.T) {
    r := newTestRouterAdmin(t)

    // Seed v1 UI-mode template
    body := map[string]any{
        "name": "nv-" + randSuffix(), "display_name": "NV",
        "authoring_mode": "ui",
        "ui_state": map[string]any{
            "resources": []any{
                map[string]any{"apiVersion":"v1","kind":"ConfigMap","name":"c","fields": map[string]any{
                    "data.k": map[string]any{"mode":"fixed","fixedValue":"v1"},
                }},
            },
        },
    }
    raw, _ := json.Marshal(body)
    w := do(t, r, http.MethodPost, "/v1/templates", bytes.NewReader(raw))
    require.Equal(t, http.StatusCreated, w.Code)
    var created struct{ Template struct{ Name string } `json:"template"` }
    _ = json.Unmarshal(w.Body.Bytes(), &created)
    name := created.Template.Name

    // Create v2 draft with new UI state
    nvBody := map[string]any{
        "authoring_mode": "ui",
        "ui_state": map[string]any{
            "resources": []any{
                map[string]any{"apiVersion":"v1","kind":"ConfigMap","name":"c","fields": map[string]any{
                    "data.k": map[string]any{"mode":"fixed","fixedValue":"v2"},
                }},
            },
        },
    }
    nvRaw, _ := json.Marshal(nvBody)
    w = do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions", bytes.NewReader(nvRaw))
    require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
    require.Contains(t, w.Body.String(), `"version":2`)
    require.Contains(t, w.Body.String(), `"status":"draft"`)
}

func TestTemplates_NewVersion_RejectsWhenDraftExists(t *testing.T) {
    r := newTestRouterAdmin(t)
    name := seedGlobalTemplate(t, r) // leaves a draft v1

    nvBody := `{"authoring_mode":"yaml","resources_yaml":"apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata: {k: v}\n","ui_spec_yaml":"fields: []\n"}`
    w := do(t, r, http.MethodPost, "/v1/templates/"+name+"/versions", bytes.NewReader([]byte(nvBody)))
    require.Equal(t, http.StatusConflict, w.Code)
}
```

- [ ] **Step 1: Run — expect FAIL (endpoint missing)**

```bash
cd backend && go test ./internal/api/... -run NewVersion
```

- [ ] **Step 2: Implement the endpoint**

Append to `backend/internal/api/templates.go`:
```go
type createVersionReq struct {
    AuthoringMode string                   `json:"authoring_mode" binding:"required,oneof=yaml ui"`
    ResourcesYAML string                   `json:"resources_yaml"`
    UISpecYAML    string                   `json:"ui_spec_yaml"`
    UIState       *template.UIModeTemplate `json:"ui_state"`
    MetadataYAML  string                   `json:"metadata_yaml"`
    Notes         string                   `json:"notes"`
}

func (h *Handlers) CreateTemplateVersion(c *gin.Context) {
    tpl, ok := h.ensureTemplateEditor(c, c.Param("name"))
    if !ok {
        return
    }

    var r createVersionReq
    if err := c.ShouldBindJSON(&r); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }

    // mode / payload consistency — identical rules to POST /v1/templates.
    switch r.AuthoringMode {
    case "ui":
        if r.UIState == nil {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui requires ui_state")
            return
        }
        if r.ResourcesYAML != "" || r.UISpecYAML != "" {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=ui must not send resources_yaml/ui_spec_yaml")
            return
        }
        res, spec, err := template.SerializeUIMode(*r.UIState)
        if err != nil {
            writeError(c, http.StatusBadRequest, "validation-error", err.Error())
            return
        }
        r.ResourcesYAML, r.UISpecYAML = res, spec
    case "yaml":
        if r.UIState != nil {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml must not send ui_state")
            return
        }
        if r.ResourcesYAML == "" || r.UISpecYAML == "" {
            writeError(c, http.StatusBadRequest, "validation-error", "authoring_mode=yaml requires resources_yaml + ui_spec_yaml")
            return
        }
    }
    if _, err := template.Render(r.ResourcesYAML, r.UISpecYAML, []byte("{}"), template.Labels{}); err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", err.Error())
        return
    }

    // enforce: at most one draft per template.
    existing, err := h.deps.Store.ListTemplateVersions(c, tpl.Name)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    for _, v := range existing {
        if v.Status == "draft" {
            writeError(c, http.StatusConflict, "conflict",
                "a draft already exists for this template; publish or delete it before creating a new version")
            return
        }
    }

    nextVer, err := h.deps.Store.NextTemplateVersion(c, tpl.ID)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
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

    var uiStateJSON pgtype.JSONB
    if r.UIState != nil {
        b, _ := json.Marshal(r.UIState)
        uiStateJSON = pgtype.JSONB{Bytes: b, Status: pgtype.Present}
    }

    ver, err := h.deps.Store.InsertTemplateVersionV2(c, store.InsertTemplateVersionV2Params{
        TemplateID: tpl.ID, Version: nextVer,
        ResourcesYaml: r.ResourcesYAML, UiSpecYaml: r.UISpecYAML,
        MetadataYaml: pgText(r.MetadataYAML), Status: "draft",
        Notes: pgText(r.Notes),
        CreatedByUserID: user.ID,
        AuthoringMode: r.AuthoringMode,
        UiStateJson: uiStateJSON,
    })
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusCreated, ver)
}
```

- [ ] **Step 3: Wire route**

In `routes.go`:
```go
v.POST("/templates/:name/versions", h.CreateTemplateVersion)
```

Permission is enforced inside via `ensureTemplateEditor`.

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && go test ./internal/api/... -run NewVersion
```

- [ ] **Step 5: Write the frontend page**

Path: `frontend/app/templates/[name]/versions/[v]/edit/page.tsx`
```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SchemaTree } from "@/components/SchemaTree";
import { FieldInspector } from "@/components/FieldInspector";
import { YamlPreview, UIModeTemplate } from "@/components/YamlPreview";
import { findKindSchema, OpenAPISchemaDoc, SchemaNode } from "@/lib/openapi";

export default function EditUITemplateVersion() {
  const { name, v } = useParams<{ name: string; v: string }>();
  const router = useRouter();
  const [state, setState] = useState<UIModeTemplate | null>(null);
  const [schemas, setSchemas] = useState<Record<string, SchemaNode>>({}); // key: `${gv}/${kind}`
  const [cluster, setCluster] = useState("");
  const [active, setActive] = useState<{ resIdx: number; path: string; node: SchemaNode } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const vRes = await fetch(`/api/v1/templates/${name}/versions/${v}`);
      if (!vRes.ok) { setErr(await vRes.text()); return; }
      const ver = await vRes.json() as { authoring_mode: string; ui_state_json: UIModeTemplate };
      if (ver.authoring_mode !== "ui") {
        setErr("이 버전은 YAML 모드로 작성되어 UI 에디터에서 열 수 없습니다.");
        return;
      }
      setState(ver.ui_state_json);

      const cRes = await fetch("/api/v1/clusters");
      if (cRes.ok) {
        const d = await cRes.json() as { clusters: Array<{ name: string }> };
        if (d.clusters[0]) setCluster(d.clusters[0].name);
      }
    })();
  }, [name, v]);

  useEffect(() => {
    if (!state || !cluster) return;
    (async () => {
      const out: Record<string, SchemaNode> = { ...schemas };
      for (const r of state.resources) {
        const key = `${r.apiVersion}/${r.kind}`;
        if (out[key]) continue;
        const gv = r.apiVersion; // "apps/v1" or "v1"
        const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi/${gv}`);
        if (!res.ok) continue;
        const doc = await res.json() as OpenAPISchemaDoc;
        const [group, version] = gv.includes("/") ? gv.split("/") : ["", gv];
        const s = findKindSchema(doc, group, version, r.kind);
        if (s) out[key] = s;
      }
      setSchemas(out);
    })();
  }, [state, cluster]);

  const uiStateSynthetic = useMemo<UIModeTemplate | null>(() => state, [state]);

  async function saveAsNewVersion() {
    setErr(null);
    if (!state) return;
    const res = await fetch(`/api/v1/templates/${name}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authoring_mode: "ui", ui_state: state }),
    });
    if (!res.ok) { setErr(`${res.status}: ${await res.text()}`); return; }
    router.push(`/templates/${name}`);
  }

  if (err) return <div className="text-red-600 text-sm">{err}</div>;
  if (!state) return <div>로딩 중…</div>;

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-3">
        <h2 className="font-semibold mb-2">편집 중 ({name} v{v})</h2>
        {state.resources.map((r, i) => {
          const s = schemas[`${r.apiVersion}/${r.kind}`];
          return (
            <div key={i} className="border rounded p-2 mb-2">
              <div className="text-xs text-slate-500 mb-1">{r.apiVersion} · {r.kind} · {r.name}</div>
              {s ? <SchemaTree
                schema={s}
                selectedPath={active?.resIdx === i ? active.path : null}
                onSelect={(p, n) => setActive({ resIdx: i, path: p, node: n })}
              /> : <div className="text-xs text-slate-400">스키마 로딩 중…</div>}
            </div>
          );
        })}
      </div>
      <div className="col-span-5">
        {active && (
          <FieldInspector
            path={active.path}
            node={active.node}
            value={state.resources[active.resIdx].fields[active.path] as any}
            onChange={v => setState(prev => prev ? ({
              ...prev,
              resources: prev.resources.map((r, i) => i === active.resIdx
                ? { ...r, fields: { ...r.fields, [active.path]: v as unknown } }
                : r
              ),
            }) : prev)}
            onClear={() => setState(prev => prev ? ({
              ...prev,
              resources: prev.resources.map((r, i) => {
                if (i !== active.resIdx) return r;
                const { [active.path]: _, ...rest } = r.fields;
                return { ...r, fields: rest };
              }),
            }) : prev)}
          />
        )}
        <button onClick={saveAsNewVersion} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded">새 버전으로 저장 (draft)</button>
        {err && <div className="text-red-600 text-sm mt-2">{err}</div>}
      </div>
      <div className="col-span-4">
        {uiStateSynthetic && <YamlPreview uiState={uiStateSynthetic} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Manual verification**

1. Open a UI-mode template version: `/templates/<name>/versions/1/edit`
2. Confirm tree + inspector + preview populate from stored `ui_state_json`
3. Attempt to open a legacy YAML version: expect the error message
4. Edit `data.k` to a new value and click "새 버전으로 저장" → template detail page should show v2 as draft. Publish v2 → catalog reflects the change.

- [ ] **Step 7: Commit**

```bash
git add backend/ frontend/
git commit -m "feat: POST /v1/templates/:name/versions + UI edit-to-new-draft page"
```

---

### Task 19: Frontend — `/templates/[name]` updates (deprecate, legacy badge, mode-aware edit)

**Files:**
- Modify: `frontend/app/templates/[name]/page.tsx`

- [ ] **Step 1: Extend the detail page**

Path: `frontend/app/templates/[name]/page.tsx`
```tsx
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { apiFetch } from "@/lib/api-server";

export default async function TemplateDetail({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const tRes = await apiFetch(`/v1/templates/${name}`);
  if (!tRes.ok) throw new Error(`템플릿 조회 실패: ${tRes.status} ${await tRes.text()}`);
  const t = await tRes.json();
  const vsRes = await apiFetch(`/v1/templates/${name}/versions`);
  if (!vsRes.ok) throw new Error(`버전 조회 실패: ${vsRes.status} ${await vsRes.text()}`);
  const vs = await vsRes.json();

  async function publish(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/publish`, { method: "POST" });
    if (!res.ok) throw new Error(`publish 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  async function deprecate(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/deprecate`, { method: "POST" });
    if (!res.ok) throw new Error(`deprecate 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  async function undeprecate(formData: FormData) {
    "use server";
    const version = formData.get("version") as string;
    const res = await apiFetch(`/v1/templates/${name}/versions/${version}/undeprecate`, { method: "POST" });
    if (!res.ok) throw new Error(`undeprecate 실패: ${res.status} ${await res.text()}`);
    revalidatePath(`/templates/${name}`);
  }

  return (
    <div>
      <h1 className="text-xl font-bold">{t.display_name}</h1>
      <p className="text-slate-600">{t.description}</p>
      <h2 className="mt-6 font-semibold">버전</h2>
      <ul className="space-y-2 mt-2">
        {vs.versions?.map(
          (v: { id: string; version: number; status: string; authoring_mode: string }) => (
            <li key={v.id} className="flex items-center gap-3">
              <span>v{v.version}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  v.status === "published" ? "bg-green-100 text-green-800"
                  : v.status === "deprecated" ? "bg-slate-200 text-slate-700"
                  : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {v.status}
              </span>
              {v.authoring_mode === "yaml" && (
                <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600">legacy YAML</span>
              )}
              {v.status === "draft" && (
                <form action={publish}>
                  <input type="hidden" name="version" value={v.version} />
                  <button className="text-blue-600 text-sm">Publish</button>
                </form>
              )}
              {v.status === "published" && (
                <form action={deprecate}>
                  <input type="hidden" name="version" value={v.version} />
                  <button className="text-red-600 text-sm">Deprecate</button>
                </form>
              )}
              {v.status === "deprecated" && (
                <form action={undeprecate}>
                  <input type="hidden" name="version" value={v.version} />
                  <button className="text-blue-600 text-sm">Undeprecate</button>
                </form>
              )}
              {v.authoring_mode === "ui" && (
                <Link href={`/templates/${name}/versions/${v.version}/edit`} className="text-blue-600 text-sm">
                  편집
                </Link>
              )}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Manual verification**

1. `/templates/<name>`: legacy YAML versions display the "legacy YAML" badge with no edit button.
2. Published UI-mode versions show Deprecate; clicking flips to Deprecated + Undeprecate button.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/templates/[name]/page.tsx
git commit -m "feat(frontend): template detail — deprecate controls + legacy YAML badge"
```

---

### Task 20: Frontend — catalog hides deprecated versions

Catalog currently lists templates whose latest version is published. Plan 2 behaviour: a template whose ONLY published version is deprecated should be hidden; a template with `published` + `deprecated` should show only the published badge.

**Files:**
- Modify: `frontend/app/catalog/page.tsx`

- [ ] **Step 1: Modify the page**

Path: `frontend/app/catalog/page.tsx`
```tsx
import Link from "next/link";
import { apiFetch } from "@/lib/api-server";

interface TemplateRow {
  name: string;
  display_name: string;
  description: { String: string; Valid: boolean };
  current_version: { Int32: number; Valid: boolean };
  // Plan 2 additions (backend returns these via ListTemplates join): current_status may be
  // absent for legacy rows; treat missing as "unknown" and include.
  current_status?: string;
}

export default async function CatalogPage() {
  const res = await apiFetch("/v1/templates");
  if (!res.ok) throw new Error(await res.text());
  const { templates } = await res.json() as { templates: TemplateRow[] };

  const visible = templates.filter(t => t.current_status !== "deprecated");

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">카탈로그</h1>
      <div className="grid grid-cols-3 gap-4">
        {visible.map(t => (
          <div key={t.name} className="bg-white border rounded p-4">
            <div className="font-semibold">{t.display_name}</div>
            <div className="text-sm text-slate-600 mb-2">
              {t.description?.Valid ? t.description.String : ""}
            </div>
            <div className="text-xs text-slate-500 mb-3">
              {t.current_version?.Valid ? `v${t.current_version.Int32}` : "아직 publish 안 됨"}
            </div>
            <Link href={`/catalog/${t.name}/deploy`} className="text-blue-600 text-sm">
              배포
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
```

(If `current_status` isn't in `ListTemplates` yet, update the query in Task 2's `templates.sql` to also return `tv.status AS current_status` and regen sqlc.)

- [ ] **Step 2: Manual verification**

1. Deprecate a template's only published version → catalog no longer lists it.
2. Undeprecate → catalog shows it again.

- [ ] **Step 3: Commit**

```bash
git add frontend/ backend/
git commit -m "feat(frontend): filter deprecated templates out of catalog"
```

---

### Task 21: Extend e2e test with Plan 2 flow

**Files:**
- Modify: `backend/e2e/e2e_test.go`

- [ ] **Step 1: Append new test**

Append to `backend/e2e/e2e_test.go`:
```go
// TestE2E_Plan2_TeamEditorFlow exercises:
//   admin registers cluster → creates team → adds alice as editor →
//   alice (via adminToken-like flow) creates a UI-mode template in the team →
//   publish → deploy as alice → deprecate v1 → new deploy rejected
func TestE2E_Plan2_TeamEditorFlow(t *testing.T) {
    if os.Getenv("KBP_KIND_API") == "" {
        t.Skip("KBP_KIND_API not set")
    }
    // Compose + server started by TestE2E_HappyPath; skip if that test hasn't set them up.
    // This keeps the single-binary e2e harness simple and the order deterministic:
    //   go test -tags=e2e -run "TestE2E_HappyPath|TestE2E_Plan2" -v
    adminTok := fetchDexIDToken(t, "admin@example.com", "admin")
    aliceTok := fetchDexIDToken(t, "alice@example.com", "alice")

    // 1. Create team 'plat' and add alice as editor
    resp := doAPI(t, adminTok, http.MethodPost, "/v1/teams", map[string]any{"name":"plat","display_name":"Platform"})
    require.Equal(t, http.StatusCreated, resp.StatusCode)
    var team struct{ ID string `json:"id"` }
    _ = json.NewDecoder(resp.Body).Decode(&team)
    resp.Body.Close()

    // alice must have logged in once to appear in users table; /v1/me is enough
    resp = doAPI(t, aliceTok, http.MethodGet, "/v1/me", nil)
    require.Equal(t, http.StatusOK, resp.StatusCode); resp.Body.Close()

    resp = doAPI(t, adminTok, http.MethodPost, "/v1/teams/"+team.ID+"/members",
        map[string]any{"email":"alice@example.com","role":"editor"})
    require.Equal(t, http.StatusCreated, resp.StatusCode); resp.Body.Close()

    // 2. alice creates a UI-mode template owned by team plat
    tplName := "ui-web-plat"
    resp = doAPI(t, aliceTok, http.MethodPost, "/v1/templates", map[string]any{
        "name": tplName, "display_name": "UI Web",
        "authoring_mode": "ui",
        "owning_team_id": team.ID,
        "ui_state": map[string]any{
            "resources": []any{
                map[string]any{
                    "apiVersion":"apps/v1","kind":"Deployment","name":"web",
                    "fields": map[string]any{
                        "spec.replicas": map[string]any{
                            "mode":"exposed",
                            "uiSpec":map[string]any{"label":"Replicas","type":"integer","default":1,"required":true},
                        },
                        "spec.selector.matchLabels.app": map[string]any{"mode":"fixed","fixedValue":"web"},
                        "spec.template.metadata.labels.app": map[string]any{"mode":"fixed","fixedValue":"web"},
                        "spec.template.spec.containers[0].name":  map[string]any{"mode":"fixed","fixedValue":"app"},
                        "spec.template.spec.containers[0].image": map[string]any{"mode":"fixed","fixedValue":"nginx:1.25"},
                    },
                },
            },
        },
    })
    require.Equal(t, http.StatusCreated, resp.StatusCode, bodyOf(resp))
    resp.Body.Close()

    // 3. publish v1 (alice is editor)
    resp = doAPI(t, aliceTok, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/publish", nil)
    require.Equal(t, http.StatusOK, resp.StatusCode); resp.Body.Close()

    // 4. alice deploys it
    resp = doAPI(t, aliceTok, http.MethodPost, "/v1/releases", map[string]any{
        "template": tplName, "version": 1, "cluster": "kind", "namespace": "default",
        "name": "ui-web-plat-rel",
        "values": map[string]any{"Deployment[web].spec.replicas": 1},
    })
    require.Equal(t, http.StatusCreated, resp.StatusCode, bodyOf(resp))
    var rel struct{ ID string `json:"id"` }
    _ = json.NewDecoder(resp.Body).Decode(&rel)
    resp.Body.Close()

    // 5. deprecate v1
    resp = doAPI(t, aliceTok, http.MethodPost, "/v1/templates/"+tplName+"/versions/1/deprecate", nil)
    require.Equal(t, http.StatusOK, resp.StatusCode); resp.Body.Close()

    // 6. new deploy attempt fails
    resp = doAPI(t, aliceTok, http.MethodPost, "/v1/releases", map[string]any{
        "template": tplName, "version": 1, "cluster": "kind", "namespace": "default",
        "name": "ui-web-plat-rel-2",
        "values": map[string]any{"Deployment[web].spec.replicas": 1},
    })
    require.Equal(t, http.StatusBadRequest, resp.StatusCode, bodyOf(resp))
    require.Contains(t, bodyOf(resp), "deprecated")
    resp.Body.Close()

    // 7. cleanup: delete the running release
    resp = doAPI(t, aliceTok, http.MethodDelete, "/v1/releases/"+rel.ID, nil)
    require.Equal(t, http.StatusNoContent, resp.StatusCode); resp.Body.Close()
}

// bodyOf consumes resp.Body (safe because callers immediately Close after).
func bodyOf(r *http.Response) string {
    b, _ := io.ReadAll(r.Body)
    return string(b)
}
```

- [ ] **Step 2: Run against kind**

Per `docs/local-e2e.md` (kind cluster + compose up + dev admin override):
```bash
export KBP_KIND_API=https://127.0.0.1:6443
cd backend && go test -tags=e2e -run "TestE2E" -v ./e2e/...
```
Expected: both `TestE2E_HappyPath` and `TestE2E_Plan2_TeamEditorFlow` PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/e2e/e2e_test.go
git commit -m "test(e2e): plan 2 team-editor flow — create team, UI template, publish, deploy, deprecate"
```

---

### Task 22: Playwright UI regression tests

Plan 2's main risk surface is the UI editor — schema-tree interactions, inspector state, live preview, and the team admin pages. Go e2e (Task 21) only covers API-level flow. This task adds a Playwright suite that drives the browser end-to-end, so regressions in later plans fail CI instead of showing up at review time.

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/tests/e2e/fixtures.ts` (shared login helper)
- Create: `frontend/tests/e2e/team-admin.spec.ts`
- Create: `frontend/tests/e2e/ui-editor.spec.ts`
- Create: `frontend/tests/e2e/deprecate-flow.spec.ts`
- Modify: `frontend/package.json` (scripts + devDependency)
- Modify: `.gitignore` (playwright artifacts)
- Modify: `Makefile` (`make e2e-ui` target)

- [ ] **Step 1: Install Playwright**

```bash
cd frontend
pnpm add -D @playwright/test
pnpm exec playwright install chromium --with-deps
```

- [ ] **Step 2: Config**

Path: `frontend/playwright.config.ts`
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.KBP_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Tests assume the full local-e2e.md stack is already running (compose + kind
  // + backend + frontend dev). Playwright doesn't boot them.
  workers: 1, // sequential — tests share app state (teams, templates)
});
```

Append to `frontend/.gitignore`:
```
tests/e2e/.auth/
test-results/
playwright-report/
```

Add npm scripts to `frontend/package.json`:
```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

Add root `Makefile` target:
```makefile
e2e-ui:
	cd frontend && pnpm test:e2e
.PHONY: e2e-ui
```

- [ ] **Step 3: Login fixture**

Path: `frontend/tests/e2e/fixtures.ts`
```ts
import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";

/**
 * OIDC flow is real (dex → Next.js callback → DB session). We perform a
 * one-time login per user and reuse the storage state across tests.
 */
async function loginAs(
  email: string,
  password: string,
  stateFile: string,
): Promise<void> {
  if (existsSync(stateFile)) return;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto("/api/auth/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /log in|login/i }).click();
  await page.waitForURL(/\/catalog|\//);
  mkdirSync(".auth", { recursive: true });
  await ctx.storageState({ path: stateFile });
  await browser.close();
}

export const test = base.extend<{ adminPage: typeof base.extend }>({
  // Two roles pre-baked: adminPage and alicePage.
});

export { expect };

export async function adminStorage(): Promise<string> {
  const p = "tests/e2e/.auth/admin.json";
  await loginAs("admin@example.com", "admin", p);
  return p;
}

export async function aliceStorage(): Promise<string> {
  const p = "tests/e2e/.auth/alice.json";
  await loginAs("alice@example.com", "alice", p);
  return p;
}
```

- [ ] **Step 4: Team admin spec**

Path: `frontend/tests/e2e/team-admin.spec.ts`
```ts
import { test, expect, adminStorage } from "./fixtures";

test.describe("team admin", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("create team and add alice as editor", async ({ page }) => {
    const name = `e2e-team-${Date.now()}`;
    await page.goto("/admin/teams");
    await page.getByPlaceholder(/slug/).fill(name);
    await page.getByRole("button", { name: "새 팀" }).click();
    await expect(page.getByText(name)).toBeVisible();

    await page.getByRole("link", { name: name }).click();
    await page.getByPlaceholder(/이메일/).fill("alice@example.com");
    await page.getByRole("combobox").selectOption("editor");
    await page.getByRole("button", { name: "추가" }).click();

    await expect(page.getByText("alice@example.com")).toBeVisible();
    await expect(page.getByText("editor")).toBeVisible();
  });
});
```

- [ ] **Step 5: UI editor spec**

Path: `frontend/tests/e2e/ui-editor.spec.ts`
```ts
import { test, expect, adminStorage } from "./fixtures";

test.describe("UI mode editor", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("create a Deployment template end-to-end", async ({ page }) => {
    await page.goto("/templates/new");

    // Pick Deployment from KindPicker
    await page.getByRole("button", { name: "Deployment" }).click();

    // Wait for schema tree
    await expect(page.locator("text=spec")).toBeVisible({ timeout: 10_000 });

    // Click spec.replicas and mark exposed
    await page.locator("text=replicas").click();
    await page.getByRole("button", { name: "사용자 노출" }).click();

    // Wait for live preview to include "replicas"
    await expect(page.locator(".monaco-editor").first()).toContainText("replicas", { timeout: 10_000 });

    // Fill template metadata and save
    const name = `e2e-ui-${Date.now()}`;
    await page.getByPlaceholder(/템플릿 이름/).fill(name);
    await page.getByPlaceholder(/표시 이름/).fill("E2E UI Template");
    await page.getByRole("button", { name: /저장/ }).click();

    // After save the page navigates to /templates
    await page.waitForURL(/\/templates$/);
    await expect(page.getByText(name)).toBeVisible();
  });
});
```

- [ ] **Step 6: Deprecate flow spec**

Path: `frontend/tests/e2e/deprecate-flow.spec.ts`
```ts
import { test, expect, adminStorage } from "./fixtures";

test.describe("deprecate flow", () => {
  test.use({ storageState: async ({}, use) => use(await adminStorage()) });

  test("published → deprecated → hidden from catalog → undeprecate", async ({ page }) => {
    // Assumes at least one published template from the ui-editor spec above.
    await page.goto("/templates");
    const firstTemplateLink = page.locator("a[href^='/templates/']").first();
    await firstTemplateLink.click();

    // Publish v1 if still draft (idempotent-ish)
    const publishBtn = page.getByRole("button", { name: /Publish/i });
    if (await publishBtn.count() > 0) await publishBtn.click();

    // Deprecate
    await page.getByRole("button", { name: /Deprecate/i }).click();
    await expect(page.getByText(/deprecated/)).toBeVisible();

    // Catalog no longer shows it
    const templateName = page.url().split("/templates/")[1];
    await page.goto("/catalog");
    await expect(page.getByText(templateName)).toHaveCount(0);

    // Undeprecate restores it
    await page.goto(`/templates/${templateName}`);
    await page.getByRole("button", { name: /Undeprecate/i }).click();
    await expect(page.getByText(/published/)).toBeVisible();
    await page.goto("/catalog");
    await expect(page.getByText(templateName).first()).toBeVisible();
  });
});
```

- [ ] **Step 7: Run against the live stack**

With everything from `docs/local-e2e.md` running (compose + kind + backend + frontend dev):
```bash
cd frontend && pnpm test:e2e
```
Expected: 3 spec files, all pass. On failure, `playwright-report/` has HTML + trace.

- [ ] **Step 8: Commit**

```bash
git add frontend/playwright.config.ts frontend/tests/e2e/ frontend/package.json frontend/pnpm-lock.yaml frontend/.gitignore Makefile
git commit -m "test(frontend): playwright suite for team admin, UI editor, deprecate flow"
```

---

### Task 23: Update README + docs

- [ ] **Step 1: README status line**

Replace the Plan 2 roadmap row in both READMEs (English and Korean) with a ✅ and update the status block to say Plan 2 shipped.

In `README.md`:
```markdown
**Status:** Plans 1 and 2 shipped. Admins can build templates in a UI editor, own them via teams, deprecate versions; users deploy, see status, and never see deprecated templates in the catalog. Plan 3 (User observability) is not written yet.
```

```markdown
| 2 | **Admin UX** | UI-mode editor (tree + meta + live preview), publish/deprecate, version history, teams | [plan](docs/superpowers/plans/2026-04-18-mvp-2-admin-ux.md) ✅ |
```

Mirror in `README.ko.md`:
```markdown
**상태:** Plan 1·2 출시. 관리자는 UI 에디터로 템플릿을 만들고 팀으로 소유하며 버전을 deprecate할 수 있다. 사용자는 배포·상태 조회가 가능하고 카탈로그에 deprecated 버전은 보이지 않는다. Plan 3(User observability) 미작성.
```

```markdown
| 2 | **Admin UX** | UI 모드 에디터(트리 + 메타 + 라이브 프리뷰), publish/deprecate, 버전 히스토리, 팀 | [plan](docs/superpowers/plans/2026-04-18-mvp-2-admin-ux.md) ✅ |
```

- [ ] **Step 2: local-e2e.md addendum**

Append a section `## UI mode (Plan 2)`:
```markdown
## UI mode (Plan 2)

Once everything from §9 above is running:

1. `http://localhost:3000/admin/teams` → create a team, add yourself as editor.
2. `http://localhost:3000/templates/new` → pick "Deployment", click `spec.replicas` → mark "사용자 노출", click container image → mark "값 고정" = `nginx:1.25`. Name the template, assign the team, save.
3. Back at `/templates/<name>`, publish v1.
4. `/catalog` → deploy.
5. `/templates/<name>` → Deprecate v1. Verify:
   - `/catalog` no longer lists it,
   - a second deploy attempt returns 400.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.ko.md docs/local-e2e.md
git commit -m "docs: update READMEs + local-e2e.md for Plan 2 shipped"
```

---

## Done criteria

Before considering Plan 2 complete, run through spec §9 (pre-release validation checklist) and confirm:

- [ ] Plan 1 legacy templates still deploy and delete (`authoring_mode='yaml'` path untouched).
- [ ] Global templates (`owning_team_id null`) are only editable by `kubeport-admin`, readable by everyone.
- [ ] Team membership changes take effect on the next API call (no session invalidation needed because requireAuth re-reads Claims per request, and permission checks re-read `team_memberships` per mutation).
- [ ] Deprecated version → `POST /v1/releases` returns `400 validation-error`.
- [ ] OpenAPI fetch against a CRD-heavy cluster (≥ 20 CRDs) finishes within a few seconds for the index and doesn't blow memory for a single GV.
- [ ] `go test ./...` passes. `go test -tags=e2e` passes.

---

*End of Plan 2.*
