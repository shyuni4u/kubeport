# Backend Meta Normalization & UX Gaps Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Plans 3·4 구현 중 발견된 백엔드 응답/스키마 불일치와 UX 구멍을 정리. 프론트 defensive 파싱·N+1 호출·기능 공백을 근본 수준에서 닫는다. **MVP 론칭 전 필수**.

**Origin:** 각 항목마다 언제/어디서 발견됐는지 함께 기록 — 추상적인 "청소" 가 아니라 실제로 **관찰된** 통증점들이다.

**전제:** Plans 0·1·2·3·4 모두 머지 완료. 백엔드 스키마 (`atlas migrate`) · sqlc 재생성 가능 상태.

---

## Task 1: `GET /v1/templates/:name` 응답 확장 — `current_version` + `owning_team_name` 포함

**Files:**
- Modify: `backend/internal/store/queries/templates.sql` — `GetTemplateByName` 쿼리에 JOIN
- Modify: `backend/internal/api/templates.go` — 핸들러가 새 필드 노출
- Modify: `backend/internal/store/templates.sql.go` — sqlc regenerate
- Modify: `frontend/app/catalog/[name]/deploy/page.tsx` — `/v1/templates` list 필터 제거, 단일 fetch 로 전환
- Modify: 관련 테스트

**원인 (Plan 3 Task 8 구현 중 발견):**
현재 `/v1/templates/:name` 는 raw `templates` 행만 반환 → `current_version` 정수 필드가 없음. 프론트가 어쩔 수 없이 `/v1/templates` (list) 를 호출해서 name 으로 필터링하는 O(N) 워크어라운드 중. `owning_team_name` 도 같은 이유로 미노출.

**변경 후 응답:**
```json
{
  "id": "uuid",
  "name": "nginx-app",
  "display_name": "Nginx App",
  "description": "…",
  "tags": ["web"],
  "current_version": 3,
  "current_version_id": "uuid",
  "owning_team_id": "uuid|null",
  "owning_team_name": "platform|null",
  "created_at": "...",
  "updated_at": "..."
}
```

SQL: LEFT JOIN `template_versions` (id = current_version_id) + LEFT JOIN `teams` (id = owning_team_id). 순서상 `current_version` 은 `tv.version` INT, `owning_team_name` 은 `t.name` TEXT.

- [ ] **Step 1**: 쿼리 JOIN + sqlc regenerate
- [ ] **Step 2**: 핸들러에서 새 필드 응답에 포함 (기존 필드는 그대로 유지 → backward compat)
- [ ] **Step 3**: 핸들러 테스트에 새 필드 assertion 추가
- [ ] **Step 4**: 프론트 `deploy/page.tsx` 를 단일 fetch 로 전환, N+1 필터 로직 삭제
- [ ] **Step 5**: 커밋 — `feat(api): GET /v1/templates/:name includes current_version + owning_team_name`

---

## Task 2: `releases.values_json` serialization — `[]byte` → `json.RawMessage`

**Files:**
- Modify: `backend/internal/store/queries/releases.sql` — 아무 변경 없음 (컬럼 타입은 jsonb)
- Modify: `backend/internal/store/releases.sql.go` — sqlc override 로 `json.RawMessage` 사용
- Modify: `backend/sqlc.yaml` — 해당 컬럼 override 설정
- Modify: `frontend/app/catalog/[name]/versions/[v]/deploy/page.tsx` — defensive base64 파싱 제거

**원인 (Plan 3 Task 9 구현 중 발견):**
`GetReleaseByIDRow.ValuesJson` 가 Go `[]byte` 타입 → `encoding/json` 이 **base64 문자열**로 serialize → 프론트가 `"eyJmb28..."` 같은 인코딩된 값을 받음. 현재 프론트는 "object/string/base64" 세 형태를 모두 defensive 파싱 중. 이건 그냥 백엔드 수정.

**변경:**
`sqlc.yaml` 에 type override 추가:
```yaml
overrides:
  - column: releases.values_json
    go_type:
      import: "encoding/json"
      type: "RawMessage"
```

regenerate → `ValuesJson json.RawMessage` → 응답에 inline JSON 으로 나감.

- [ ] **Step 1**: `sqlc.yaml` override 추가, regenerate
- [ ] **Step 2**: `releases_test.go` 의 `ValuesJson` 관련 assertion 업데이트 (이미 RawMessage 면 기존이 통과할 수도 — 확인)
- [ ] **Step 3**: 프론트 `parseValuesJson` 헬퍼 제거, 직접 `as Record<string, unknown>` 사용
- [ ] **Step 4**: 커밋 — `fix(api): releases.values_json serializes as inline JSON (json.RawMessage)`

---

## Task 3: `PATCH /v1/templates/:name` 신설 — display_name/tags 편집

**Files:**
- Modify: `backend/internal/api/routes.go`
- Create: `backend/internal/api/template_update.go`
- Create: `backend/internal/api/template_update_test.go`
- Modify: `backend/internal/store/queries/templates.sql` — `UpdateTemplateMeta` 쿼리
- Modify: `backend/internal/store/templates.sql.go` — sqlc regenerate
- Modify: `frontend/components/editor/MetaRow.tsx` — `readOnly` prop 제거 OR 유지 후 호출 측에서 편집 가능하도록
- Modify: `frontend/app/templates/[name]/versions/[v]/edit/page.tsx` — MetaRow `readOnly` 제거, meta 변경 시 별도 PATCH 호출

**원인 (Plan 4 Gemini HIGH 지적에서 발견):**
edit 페이지에서 MetaRow 로 display_name/tags 편집해도 저장 누락됨 — `POST /templates/:name/versions` 가 `template_versions` 행만 쓰고 `templates` 행을 안 건드림. pre-existing 구멍이지만 Plan 4 에서 UI 노출하면서 발각. 현재는 palliative 로 MetaRow `readOnly` 처리.

**API:**
- Endpoint: `PATCH /v1/templates/:name`
- Auth: admin OR template 의 owning team editor (기존 `ensureTeamEditor` 재사용)
- Body: `{ display_name?: string, description?: string, tags?: string[] }` (partial update)
- 각 필드 생략 시 해당 컬럼 유지
- Response: 200 업데이트된 template 행 (Task 1 의 확장 shape 따름)

**쿼리:**
```sql
-- name: UpdateTemplateMeta :one
UPDATE templates
SET display_name = COALESCE($2, display_name),
    description  = COALESCE($3, description),
    tags         = COALESCE($4, tags),
    updated_at   = NOW()
WHERE name = $1
RETURNING *;
```

sqlc 에서 nullable 파라미터 처리: `pgtype.Text`, `pgtype.Array[string]` — 또는 조건부 업데이트로 핸들러 쪽에서 CASE 분기.

- [ ] **Step 1**: SQL 쿼리 + sqlc regenerate
- [ ] **Step 2**: 핸들러 + 인증 + partial update 로직 (`bind` 시 `*string` 포인터 사용, nil → 미변경)
- [ ] **Step 3**: 테스트 — 성공/인증실패/존재안함/각 필드 개별 수정
- [ ] **Step 4**: 라우트 등록
- [ ] **Step 5**: 프론트 edit 페이지 wiring — meta 변경 감지 후 save 시 `ui_state` POST 와 별도로 PATCH 호출 (병렬 or 순차 둘 다 가능, 순차가 에러 처리 명확)
- [ ] **Step 6**: MetaRow `readOnly` prop 은 제거하지 않음 — 다른 쓰임새 (예: 읽기 전용 뷰어) 가 있을 수 있음. edit 페이지에서 `readOnly={false}` 로만 전환.
- [ ] **Step 7**: 커밋 — `feat(api): PATCH /v1/templates/:name for display_name/tags editing`

---

## Task 4: 배포 폼 클러스터 드롭다운

**Files:**
- Modify: `frontend/app/catalog/[name]/deploy/DeployClient.tsx`

**원인 (Plan 3 구현 중 인지, 디자인 스펙과 불일치):**
현재 `cluster` 는 free-text `<Input>`. 디자인 스펙은 "관리자가 등록한 클러스터 드롭다운". 사용자가 오타를 내면 배포 시 404 `not-found: cluster`. 잘못된 타이밍에 실패함 (미리보기/RBAC 다 돌려봤는데 제출 시점에 cluster 에러).

**API 는 이미 있음:** `GET /v1/clusters` → `{ clusters: [...] }`.

- [ ] **Step 1**: DeployClient 의 cluster state 위에 `/api/v1/clusters` fetch 추가
- [ ] **Step 2**: shadcn `<Select>` 로 교체 (현재 Input 제거). 클러스터 없을 때 "관리자에게 요청하세요" 플레이스홀더.
- [ ] **Step 3**: localStorage 저장 유지 (Plan 3 기능) — 저장된 cluster 가 목록에 없으면 무시하고 기본 선택
- [ ] **Step 4**: 커밋 — `feat(frontend): deploy form uses cluster dropdown (from /v1/clusters)`

---

## Task 5: 검증 + PR

- [ ] 백엔드: `go test ./...` all green
- [ ] 프론트: `pnpm test && pnpm lint && pnpm build`
- [ ] Manual smoke: 카탈로그 → 배포 (cluster 드롭다운) → preview → RBAC → 제출. edit 페이지에서 display_name 바꾸고 저장 후 reload 시 유지되는지.
- [ ] PR 생성, Gemini 리뷰

---

## 스코프 밖 (후속)

- 템플릿 삭제 (`DELETE /v1/templates/:name`) — 별도 플랜 (soft delete 설계 필요)
- 팀 편집 in MetaRow (현재 별도 Select) — UX 통합 가치 여부 사용자 피드백 기반 결정
- Publish from editor (BottomBar 의 canPublish=false 상태) — 별도 UX 플랜
