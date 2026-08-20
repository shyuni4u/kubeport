# Plan 6 — Post-MVP Stabilization (2026-04-22)

> **Status**: implemented on branch `fix/post-mvp-stabilization`, pending review.
> A **Plan 7** (visual refresh toward the Figma reference `nDP3cHNKf5Cjo6F2HU1EVv`) is scoped separately and will follow once this lands.
>
> **Revision (same day)**: the first browser test after the initial fixes surfaced
> three follow-on issues that were out of scope for the original frontend-only
> plan but had to be absorbed to unblock real editing:
> - Global templates hid all mutation UI for non-admins (correct) but showed them
>   to admins with a 403 on click (wrong) — we now gate the UI on `/v1/me` groups.
> - Backend allowed only one draft per template, and Plan 4 made yaml-authored
>   versions read-only, so every real template ended up unable to edit. Added
>   `PATCH /v1/templates/:name/versions/:v` and `DELETE .../versions/:v` (both
>   drafts-only) so drafts can actually be edited in place and stuck drafts can
>   be cleaned up.
> - `base-ui` Select was rendering raw UUIDs for selected team values; added a
>   label render function to the owning-team picker.

## Context

Plans 0–5 (frontend redesign + backend meta normalization) shipped and merged, but the first real end-to-end browser test on 2026-04-22 surfaced four blocking issues that prevent MVP validation:

1. **Release list shows `unknown` status for every release** — even when the underlying k8s workload is healthy (`kubectl get deploy/web` → `2/2 ready`).
2. **Template detail page has no visible edit entry point for the only type of content that exists today (YAML-mode versions)** — `frontend/app/templates/[name]/page.tsx` gated the "편집" link to `v.authoring_mode === "ui"`. Users could not edit anything they actually had.
3. **"새 템플릿" UI mode was undiscoverable** — `/templates/new` defaulted to `?mode=ui` but had no visible mode switcher. The `/templates` list's "+ 새 템플릿" button pointed to the legacy `/templates/new/edit` route, which was YAML-only.
4. **"Save draft" 400 on legacy edit route** — `frontend/app/templates/[name]/edit/page.tsx` predates Plan 2's `authoring_mode` requirement; its POST body omitted the field and backend rejected it.

All fixes are frontend-only. **No DB migration, no backend change.** The backend's `CreateTemplateVersion` and the Plan 4 `/templates/[name]/versions/[v]/edit?mode=yaml|ui` route already support everything needed.

## Tasks

### T1 — Delete legacy `/templates/[name]/edit` route

- Delete `frontend/app/templates/[name]/edit/page.tsx` (113 lines). Plan 1 artifact fully superseded by Plan 4's `/templates/[name]/versions/[v]/edit`. Root cause of Bug #4.
- Redirect the only in-app caller — `frontend/app/templates/page.tsx:13` `+ 새 템플릿` button — from `/templates/new/edit` → `/templates/new`.

### T2 — Always-visible edit + "새 버전" on template detail

**File**: `frontend/app/templates/[name]/page.tsx`.

- Remove the `v.authoring_mode === "ui"` guard on the "편집" link so it renders for all modes.
- Append `?mode={v.authoring_mode}` so the version-edit page mounts the right sub-editor.
- Display the authoring mode (`YAML` / `UI`) as a neutral chip next to the status chip so admins can tell at a glance which editor they are about to enter.
- Add a top-of-page `+ 새 버전` button (form with `createNewVersion` server action) — clones the highest-numbered version's content + authoring mode, POSTs to `/v1/templates/{name}/versions`, and redirects to the new draft's `edit` page. Without this, once all versions are published or deprecated, users have no path to start a new draft.

### T3 — Mode switcher + onboarding on `/templates/new`

**File**: `frontend/app/templates/new/page.tsx`.

- Wrap the existing mode branch in a visible `<Tabs>` (shadcn primitive at `frontend/components/ui/tabs.tsx`) labeled `UI 모드` / `YAML 모드`. `onValueChange` does `router.replace(?mode=ui|yaml)`. Default remains UI.
- Add a shared `<h1>새 템플릿</h1>` header above the tab row so the page has a proper title in both modes.
- In `UIModeNew`, render a dashed-border onboarding banner when `resources.length === 0` prompting the admin to pick a starting k8s resource kind. Avoids the "blank editor, looks broken" first-run state.

### T4 — Unify post-create redirect to `/templates`

**File**: `frontend/app/templates/new/page.tsx`.

- UI-mode `saveDraft` already `router.push("/templates")`.
- YAML-mode `saveDraft` previously pushed `/templates/{name}` — change to `/templates` so both paths land on the list (user direction: "생성 후 리다이렉트는 목록 화면이지"). The detail page (with the T2 fix) is one click away from the list.

### T5 — Drop status column from `ReleaseTable`

**File**: `frontend/components/ReleaseTable.tsx`.

- Remove the 상태 column (header + `<StatusChip>` cell) and the `status` field from the `ReleaseRow` type.
- Add an explicit empty-state message (`아직 배포된 릴리스가 없습니다.`) so an empty `/releases` page does not render a dead table.
- Status is still computed live on `/releases/{id}` detail via `GetRelease` → `abstractStatus(instances)` — unchanged.
- User direction: "목록에서 굳이 다 보여줘야하나 싶은데 .. 눌렀을 때 상태 보여주면 되자나".

### T6 — Tests

- New: `frontend/components/ReleaseTable.test.tsx` — empty-state copy + renders name/template/namespace with no status column, no "unknown" leakage.
- Pre-existing 111 vitest tests still green (no test file depended on the status column).
- `StatusChip` itself is untouched and still used by `ReleaseHeader` + `InstancesTable`.

## T7 — Draft editability (follow-on, backend + frontend)

Added after the first browser test revealed that editing existing templates
was effectively impossible. Each bullet is shippable on its own but they
belong together.

### T7a — `PATCH /v1/templates/:name/versions/:v` (drafts only)
- Hand-written SQL in `backend/internal/store/queries/templates.sql`
  (`UpdateDraftTemplateVersion`), sqlc-generated into `templates.sql.go`.
  `WHERE id = $id AND status = 'draft'` — returns zero rows for non-drafts.
- Handler `UpdateTemplateVersion` in `backend/internal/api/templates.go`:
  `ensureTemplateEditor` → GET + draft check → `template.ValidateSpec` dry-run
  → `UpdateDraftTemplateVersion` → handles `pgx.ErrNoRows` as 409 (status raced).
- Enforces authoring-mode/payload consistency matching `CreateTemplateVersion`.
- Route registered in `backend/internal/api/routes.go`.

### T7b — `DELETE /v1/templates/:name/versions/:v` (drafts only)
- `DeleteDraftTemplateVersion` query + handler.
- Defense in depth: `releases.template_version_id` FK is `ON DELETE RESTRICT`,
  so the DB itself rejects published-version deletes even if the handler
  somehow lets one through. The draft gate just turns those into clean 409s
  instead of 500 FK-violation messages.

### T7c — YamlModeEdit becomes a real editor
- `frontend/app/templates/[name]/versions/[v]/edit/page.tsx` YamlModeEdit:
  replace the "read-only" amber banner with:
  - Drafts: two YamlEditor panes + 저장 button that PATCHes the draft and
    redirects to the detail page.
  - Non-drafts: amber banner telling the user to create a new draft via the
    detail page's `+ 새 버전`.

### T7d — Draft delete button + existing-draft guard on detail
- `frontend/app/templates/[name]/page.tsx`:
  - `deleteDraft` server action → `DELETE /versions/:v` → `revalidatePath`.
  - `삭제` button rendered alongside `Publish` for draft rows.
  - Header-area action: if an existing draft already exists, swap `+ 새 버전`
    for a `draft v{n} 편집` link so we never hit the backend's "only one draft
    per template" 409 from the UI.

### T7e — Permission-aware mutation UI
- Detail page fetches `/v1/me` in parallel with the template and versions list,
  computes `canEdit = isAdmin || !isGlobalTemplate`. All mutation buttons (편집,
  Publish, Deprecate, Undeprecate, `+ 새 버전`, 삭제) gated on `canEdit`.
- Non-editors see a "읽기 전용" hint instead. Matches backend
  `ensureTemplateEditor` (global templates require admin; team templates
  require team-editor — we stay optimistic on team-editor since the member
  list isn't readable from the caller's context).

### T7f — Team picker label
- `frontend/app/templates/new/page.tsx`: `renderTeamLabel(value, teams)` helper
  + `<SelectValue>{(v) => renderTeamLabel(v, teams)}</SelectValue>` for both
  modes. Drop-down items use `display_name || name` so the selected label and
  the open-menu labels match. `Team` type extended with optional
  `display_name`.

### T7g — "+ 새 버전" is click-only (no pre-create) + save picks PATCH vs POST
- `frontend/app/templates/[name]/page.tsx`: the `+ 새 버전` button becomes a
  plain `<Link>` to the latest version's edit page. Removed the
  `createNewVersion` server action that used to POST a new draft on click —
  users who hit the button and then went back were leaving orphan drafts in
  the DB.
- `frontend/app/templates/[name]/versions/[v]/edit/page.tsx`: both
  `YamlModeEdit` and `UIModeEdit` now pick save behavior from the loaded
  version's status (`sourceStatus === "draft"` + matching authoring mode →
  PATCH the draft; otherwise POST a new version). Going back before saving
  leaves the DB untouched.
- Version-edit page also exposes the `UI 모드 / YAML 모드` tab switcher so
  admins can pick either mode when creating a new version off a published
  source.

### T7h — YAML → UI-state best-effort conversion (with warnings)
- `frontend/lib/yaml-to-ui-state.ts`: pure-frontend conversion using the
  `yaml` (`eemeli/yaml`) package. Walks parsed documents, emits every scalar
  leaf as a `fixed` field, then promotes ui-spec paths to `exposed` with the
  full UISpecEntry. Returns a warnings array for unmatched ui-spec entries,
  skipped resources (missing apiVersion/kind/metadata.name), and unsupported
  value types.
- `frontend/lib/yaml-to-ui-state.test.ts`: 5 unit tests covering resource
  enumeration, scalar capture, ui-spec promotion, unknown-resource warnings,
  and malformed-resource handling.
- UIModeEdit uses the converter when `authoring_mode !== "ui"`. An amber
  banner explains the conversion + expandable warning list lets the admin
  inspect lossy paths. Save on a converted non-draft POSTs a new ui-mode
  version. yaml drafts are preview-only (save disabled) because the backend
  forbids flipping a draft's authoring mode + only allows one draft per
  template — the banner directs the user to delete the yaml draft and start
  fresh in UI mode.

## Non-goals (explicit)

- **Visual design refresh**: deferred to Plan 7. Figma reference `nDP3cHNKf5Cjo6F2HU1EVv`.
- **Pagination/filter UI for releases**: deferred. Backend already paginates via `limit`/`offset`; UI controls can come when release counts grow.
- **Team-editor membership lookup**: the detail page stays optimistic (renders mutation UI for team templates regardless of team membership). Backend `ensureTemplateEditor` still enforces. A future plan could cache team memberships in `/v1/me` to close this gap.

## Critical files changed

| File | Action |
|---|---|
| `frontend/app/templates/[name]/edit/page.tsx` | **deleted** |
| `frontend/app/templates/page.tsx` | redirect `+ 새 템플릿` href → `/templates/new` |
| `frontend/app/templates/[name]/page.tsx` | permission-aware mutation UI; existing-draft guard; `deleteDraft` action; authoring-mode chip; 편집 link for all modes |
| `frontend/app/templates/new/page.tsx` | mode `<Tabs>`; onboarding banner; unify YAML redirect; `renderTeamLabel` for base-ui Select |
| `frontend/app/templates/[name]/versions/[v]/edit/page.tsx` | YamlModeEdit now editable (PATCH draft); status-aware read-only banner only for non-drafts |
| `frontend/components/ReleaseTable.tsx` | drop 상태 column + add empty-state |
| `frontend/components/ReleaseTable.test.tsx` | **new** |
| `frontend/components/SchemaTree.tsx` | wrap recursive `renderNode` in `<ul>` so drafts don't hit `<li>-in-<li>` hydration error |
| `backend/internal/store/queries/templates.sql` | `UpdateDraftTemplateVersion` + `DeleteDraftTemplateVersion` |
| `backend/internal/store/templates.sql.go`, `querier.go` | **regenerated** via `sqlc generate` |
| `backend/internal/api/templates.go` | `UpdateTemplateVersion` + `DeleteTemplateVersion` handlers; `updateVersionReq` type |
| `backend/internal/api/routes.go` | `PATCH` + `DELETE /v1/templates/:name/versions/:v` routes |
| `backend/internal/api/templates_version_update_test.go` | **new** — 6 integration tests covering happy path, 409 on non-draft, payload consistency, non-admin global denial |

## Verification

Run the full stack per `docs/local-e2e.md` (compose + kind + backend + frontend).

1. **T1** — `/templates` → "+ 새 템플릿" button goes to `/templates/new` (not the deleted route).
2. **T2** — `/templates` → click `web` → detail shows 편집 + YAML chip next to v1; click → `/templates/web/versions/1/edit?mode=yaml` opens Monaco with the template populated. "+ 새 버전" creates v2 as a draft cloned from v1 and navigates to its edit page.
3. **T3** — `/templates/new` shows `UI 모드 / YAML 모드` tabs under the page title. Default UI. Clicking YAML updates `?mode=yaml` and re-renders Monaco. UI mode with no resources shows the blue dashed onboarding banner.
4. **T4** — create a template in either mode → lands on `/templates` with the new template listed.
5. **T5** — `/releases` → no 상태 column, rows are name / template@v / namespace. Empty list renders "아직 배포된 릴리스가 없습니다." Click row → `/releases/{id}` still shows live status.
6. **Regression**:
   - `cd frontend && pnpm test` → **113 tests pass** (111 pre-existing + 2 new ReleaseTable).
   - `cd backend && OIDC_ISSUER=https://host.docker.internal:5556 OIDC_CA_FILE=/home/shyun/kubeport/deploy/docker/certs/dex.crt go test ./...` → all 6 packages pass, unchanged.
   - `cd frontend && pnpm exec tsc --noEmit` → clean after `rm -rf .next/types .next/dev/types` (Next.js regenerates stale validators for deleted routes).
7. **Authz sanity** (unchanged design):
   - Alice (non-admin) sees only her own releases in `/releases`.
   - Alice cannot "+ 새 버전" on a template she doesn't own (backend `ensureTemplateEditor` rejects in `CreateTemplateVersion`).
   - Admin can edit anything.

## Size

Initial fixes: ~150 LOC frontend, one delete, one test file.
Follow-on (T7a–f): ~200 LOC backend + ~120 LOC frontend + one integration test file.

Suggested branch: `fix/post-mvp-stabilization`. Single PR; `superpowers:code-reviewer` pass before merge per CLAUDE.md convention (≥3 files changed).
