# kubeport Plan 2 — Admin UX 디자인 스펙

| | |
|---|---|
| 버전 | 0.2 |
| 날짜 | 2026-04-18 |
| 상태 | **리뷰 준비됨** (v0.1 의 미결 4건 확정 반영) |
| 범위 | Plan 2 (Admin UX): UI 모드 에디터, publish/deprecate, 버전 히스토리, 팀/소유권 (미들 스코프) |
| 이전 문서 | [초기 디자인 스펙](2026-04-16-initial-design.md), [브레인스토밍 §12](../../brainstorming-summary.md) |
| 변경 이력 | v0.2 (2026-04-18) — §8 미결 4건 확정 반영, 해당 내용을 §4/§6/§7 에 통합. · v0.1 (2026-04-18) — 초안 |

이 문서는 Plan 1 (vertical slice) 머지 후 Plan 2 로 넘어가기 전 합의해야 할 구조만 다룬다. UI 픽셀 단위 디자인, 마이크로 인터랙션은 실행 단계에서 정한다. 승인 후 `writing-plans` 스킬로 태스크 분해.

---

## 1. 문제 정의

Plan 1 에서 admin 은 YAML + ui-spec 을 **수동으로 타이핑**해 템플릿을 만들어야 한다. 이 경로는:
- 진입 장벽이 높다 — k8s 스키마를 전부 외우거나 문서를 옆에 두고 써야 한다.
- 실수하기 쉽다 — ui-spec 의 JSON 경로가 resources.yaml 과 실제로 일치하는지 저장 전에 알 수 없다.
- "누가 이 템플릿을 편집·publish 할 수 있나"가 글로벌 `kubeport-admin` 단일 축뿐 — 팀 단위 분리가 없다.

Plan 2 는 **admin 이 클릭으로 템플릿을 만들고 팀 단위로 소유**하게 한다. 일반 사용자 경험(카탈로그·배포 폼·릴리스 상세)은 Plan 1 그대로 유지.

---

## 2. 목표 / 비목표

### 목표
1. admin 이 한 번도 YAML 을 직접 타이핑하지 않고도 Deployment + Service 같은 템플릿을 만들 수 있다.
2. 템플릿이 어느 팀 소유인지 명확히 하고, 팀 외부 인원은 편집할 수 없다.
3. 템플릿 버전을 publish / deprecate 할 수 있고, deprecate 된 버전으로는 신규 배포가 불가하다.
4. CRD 가 설치된 클러스터에서는 admin 이 해당 CRD 로도 템플릿을 만들 수 있다 (원래 v1.1 스코프였던 것이 자연스럽게 포함됨).

### 비목표 (Plan 3 이후)
- YAML ↔ UI 토글 양방향 편집.
- 버전 간 diff 뷰, 승인 워크플로, 감사 로그.
- 팀 초대/가입 UI (팀 생성·멤버 추가는 `kubeport-admin` 이 API 로 직접).
- 릴리스의 팀 소유 개념 (네임스페이스가 사실상 경계 역할).
- 팀 단위 카탈로그 가시성 (현재는 publish 된 모든 템플릿이 로그인 유저 전원에게 보임).

---

## 3. 사용자 여정

### 3.1 admin: 새 템플릿을 UI 로 만든다

1. `/templates` → "+ 새 템플릿 (UI 모드)" 클릭.
2. **클러스터 선택** 다이얼로그 — 등록된 클러스터 중 하나 고름. 시스템이 해당 클러스터 `/openapi/v2` 를 fetch 해서 kind 목록을 채운다.
3. **kind 추가** — `Deployment` / `Service` / `ConfigMap` / (CRD 포함) 중 하나 이상 선택. 각 kind 마다 빈 인스턴스가 트리에 생성됨.
4. **트리 편집**
   - 각 필드를 클릭 → 우측 패널에서 (a) **값 고정** (스키마 타입대로 입력), (b) **사용자에게 노출** (ui-spec 엔트리 생성: label / type / min / max / default / required).
   - 필수 필드는 기본적으로 "고정" 상태.
5. **Live YAML preview** — 좌측 트리 변경이 우측 YAML 패널에 즉시 반영 (read-only).
6. **메타데이터 입력** — 템플릿 이름, 표시명, 설명, 태그, 소속 팀.
7. **저장** → draft v1 생성.
8. **Publish** → v1 public. 카탈로그에 노출.

### 3.2 admin: 기존 템플릿의 새 버전을 만든다

- draft 가 없는 템플릿: `+ 새 버전` → 현재 published 버전의 UI state 를 복사한 새 draft 생성 → 편집 → publish → v2.
- draft 가 이미 있는 템플릿: `draft 이어서 편집` 버튼만 노출 (동시 draft 방지).
- **레거시 YAML 버전**은 UI 로 이어 편집할 수 없음. 새 버전을 만들려면 UI 모드로 처음부터 (§5.3).

### 3.3 admin: 버전을 deprecate 한다

- 템플릿 상세 → 해당 버전 행에서 "Deprecate" 버튼 → 확인 모달 ("기존 릴리스는 계속 동작, 신규 배포만 차단") → 상태 `deprecated` 로 전환.
- 되돌리기: 같은 버튼이 "Undeprecate" 로 전환되어 `published` 로 복원 (draft 는 불가).

### 3.4 admin (super): 팀을 만든다

- `/admin/teams` (새 페이지, `kubeport-admin` 전용) → 팀 이름 입력 → 생성.
- 팀 상세에서 멤버 추가: 이메일 입력 → role (editor / viewer) 선택 → 추가.
- 팀 삭제는 소속 템플릿이 0 개일 때만 가능.

### 3.5 user: Plan 1 그대로

카탈로그 / 배포 폼 / 릴리스 상세 UX 에 변경 없음. 단, deprecated 버전은 카탈로그에서 숨김·배지 처리 (§4.3).

---

## 4. 핵심 동작 상세

### 4.1 스키마 fetch 파이프라인

```
1. admin UI 가 kind 목록을 요청:
   GET /v1/clusters/:name/openapi              → apisGroupVersion 인덱스 (v3)
   GET /v1/clusters/:name/openapi/:gv          → 특정 GroupVersion 의 스키마만 lazy fetch
2. Go API 는 client-go discovery 로 k8s 의 /openapi/v3 를 호출. 사용자 id_token 포워딩.
3. 응답은 gzip 압축 후 반환. 에디터는 kind 클릭 시점에만 GV 스키마를 가져옴.
```

**왜 OpenAPI v3?** (k8s 1.24+ 표준) 전체 스키마를 한 방에 내리는 v2 와 달리 GVK 단위로 분할 조회 가능. CRD 수백 개 있는 클러스터에서도 초기 kind 목록 응답이 작고, 사용자가 선택한 kind 의 스키마만 정말로 페칭된다 — 메모리 캐시 부담과 초기 로드 시간이 한 자릿수 MB 레벨로 떨어짐.

**인증**: 유저 id_token 을 k8s API 로 그대로 포워딩한다 (Plan 1 원칙 그대로). 앱이 전용 서비스 어카운트를 갖지 않는 것이 Plan 1 보안 모델의 핵심이라 openapi 조회도 동일 경로. OpenAPI 읽기는 k8s 기본 `system:discovery` ClusterRole 에 포함되어 있어 대부분의 인증된 유저가 이미 가지고 있음.

**캐시 전략** — `(cluster, user, groupVersion)` 키로 인메모리 LRU 캐시.
- 크기 상한: 기본 **64 엔트리** (환경변수 `KBP_OPENAPI_CACHE_MAX` 로 조절), 엔트리 TTL 60 분.
- 사용자 RBAC 차이를 반영하기 위해 user 를 키에 포함 (공용 캐시로 하면 RBAC 가 약한 유저의 응답을 강한 유저가 보게 될 수 있음).
- 메모리 상한 이슈가 재발하면 Plan 3 에서 Redis / on-disk 로 이전 검토.

**Refresh** — admin 버튼 1회 클릭으로 해당 `(cluster, user, *)` 캐시 invalidate.

**CRD 지원** — 별도 코드 없음. v3 의 GroupVersion 인덱스에 CRD 의 GroupVersion 이 함께 나열되므로 core 리소스와 동일한 흐름으로 선택·편집 가능.

### 4.2 UI state → resources.yaml + ui-spec.yaml 직렬화

admin 의 트리 편집 결과를 JSON state 로 보관:

```ts
type UIModeTemplate = {
  // 저장되지 않음 — 에디터 세션에서 스키마 fetch 한 출처를 로컬로만 기억.
  // 템플릿 자체는 클러스터-중립 (배포 시 다른 클러스터 선택 자유).
  // authoredCluster: string;  // (session-only, not persisted)
  resources: Array<{
    kind: string;              // "Deployment"
    apiVersion: string;        // "apps/v1"
    name: string;              // metadata.name (에디터 자체가 강제로 명명)
    fields: Record<string, {
      mode: "fixed" | "exposed";
      fixedValue?: unknown;    // mode=fixed 일 때
      uiSpec?: {               // mode=exposed 일 때 ui-spec 엔트리
        label: string;
        help?: string;
        type: "string" | "integer" | "boolean" | "enum";
        min?: number; max?: number;
        pattern?: string; values?: string[];
        default?: unknown;
        required?: boolean;
      };
    }>;
  }>;
};
```

저장 시 서버가 이 state 를 기존 `resources_yaml` + `ui_spec_yaml` 쌍으로 직렬화 → Plan 1 의 render 파이프라인을 그대로 탄다 (백엔드 render·apply 로직 미변경).

**UI state 도 DB 저장** — `template_versions.ui_state_json` (nullable) 컬럼 신설. 다음 버전 편집 시 트리 재구성을 위해 필요 (YAML 만으로는 "어떤 필드가 exposed 인지" 외에 트리 레이아웃을 완벽히 복원 못함).

### 4.3 Deprecate 동작

| 관점 | Plan 1 (before) | Plan 2 (after) |
|------|-----------------|----------------|
| status 값 | `draft` / `published` | `draft` / `published` / `deprecated` |
| 카탈로그 노출 | published 만 | published 만 (deprecated 는 템플릿 상세에서만) |
| 신규 배포 | published 만 가능 | published 만 가능 (deprecated 는 서버측 400) |
| 기존 릴리스 | 계속 동작 | 계속 동작, 변경 없음 |
| "update available" | 현재 버전 < 최신 published 이면 | 현재 버전 < 최신 non-deprecated published 이면 |

### 4.4 권한 계산

| 동작 | 필요 권한 |
|------|----------|
| 클러스터 등록 | 글로벌 `kubeport-admin` |
| 팀 생성·멤버 추가 | 글로벌 `kubeport-admin` |
| 글로벌 템플릿 (팀 null) 편집·publish | 글로벌 `kubeport-admin` |
| 팀 템플릿 편집·publish·deprecate | 해당 팀의 `editor` OR 글로벌 `kubeport-admin` |
| 팀 템플릿 상세 열람 | 모든 로그인 유저 (카탈로그 가시성 = 로그인만 있으면 OK) |
| 배포 (릴리스 생성) | Plan 1 그대로 — k8s RBAC 가 결정 |

---

## 5. 데이터 모델 변경

### 5.1 신규 테이블

```hcl
table "teams" {
  column "id"           { type = uuid null = false default = sql("gen_random_uuid()") }
  column "name"         { type = text null = false }
  column "display_name" { type = text }
  column "created_at"   { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.id] }
  index "teams_name_uq" { columns = [column.name] unique = true }
}

table "team_memberships" {
  column "user_id" { type = uuid null = false }
  column "team_id" { type = uuid null = false }
  column "role"    { type = text null = false }   # "editor" | "viewer"
  column "created_at" { type = timestamptz null = false default = sql("now()") }
  primary_key { columns = [column.user_id, column.team_id] }
  foreign_key "tm_user_fk" { columns = [column.user_id] ref_columns = [table.users.column.id] on_delete = CASCADE }
  foreign_key "tm_team_fk" { columns = [column.team_id] ref_columns = [table.teams.column.id] on_delete = CASCADE }
  index "tm_team" { columns = [column.team_id] }
}
```

### 5.2 기존 테이블 변경

```hcl
# templates
column "owning_team_id" { type = uuid null = true }
foreign_key "t_team_fk" { columns = [column.owning_team_id] ref_columns = [table.teams.column.id] on_delete = SET_NULL }

# template_versions
column "authoring_mode" { type = text null = false default = sql("'yaml'") }   # "yaml" | "ui"
column "ui_state_json"  { type = jsonb null = true }                           # 에디터 재구성용
# status 컬럼 값 집합에 "deprecated" 추가 (Postgres 는 text 이므로 DB 변경 없음, API 측에서 enum 검증)
```

### 5.3 마이그레이션 파생 규칙

- 기존 `template_versions` 는 모두 `authoring_mode = 'yaml'`, `ui_state_json = null` → UI 에서 read-only preview.
- 기존 `templates.owning_team_id` 는 null → 글로벌 템플릿으로 취급 (권한: `kubeport-admin` 만 편집).
- "레거시 YAML 템플릿을 UI 로 마이그레이션" 기능 **없음** — 새 버전은 UI 모드로 처음부터.

---

## 6. API 변경 (추가만, 기존 유지)

### 6.1 신규 엔드포인트

| 메서드 | 경로 | 설명 | 권한 |
|--------|------|------|------|
| GET | `/v1/clusters/:name/openapi` | 해당 클러스터의 OpenAPI v2 (gzip, 캐시된 것 또는 fresh) | 인증만 |
| POST | `/v1/clusters/:name/openapi/refresh` | 캐시 invalidate | 인증만 |
| POST | `/v1/templates/preview` | UI state JSON → `resources_yaml` + `ui_spec_yaml` (stateless, DB 안 건드림). 에디터의 live preview 용. | 인증만 |
| GET | `/v1/teams` | 내가 속한 팀 목록 (admin 은 전체) | 인증 |
| POST | `/v1/teams` | 팀 생성 | `kubeport-admin` |
| GET | `/v1/teams/:id/members` | 팀 멤버 목록 | 팀 멤버 or `kubeport-admin` |
| POST | `/v1/teams/:id/members` | 멤버 추가 (email + role) | `kubeport-admin` |
| DELETE | `/v1/teams/:id/members/:user_id` | 멤버 삭제 | `kubeport-admin` |
| POST | `/v1/templates/:name/versions/:v/deprecate` | published → deprecated | 소유팀 `editor` or `kubeport-admin` |
| POST | `/v1/templates/:name/versions/:v/undeprecate` | deprecated → published | 소유팀 `editor` or `kubeport-admin` |

### 6.2 변경된 엔드포인트

- `POST /v1/templates` — body 에 다음 필드 추가:
  - `owning_team_id` (optional) — null 이면 글로벌 템플릿.
  - `authoring_mode` (required, `"yaml"` | `"ui"`) — 클라이언트가 의도를 명시. 서버는 `mode` 와 페이로드 정합성을 검증:
    - `mode="ui"` 인데 `ui_state_json` 없음 → `400 validation-error`.
    - `mode="yaml"` 인데 `ui_state_json` 있음 → `400 validation-error`.
  - 서버가 `ui_state_json` 유무로 암시 추론하지 않음 (클라 실수를 조용히 잘못된 모드로 저장하는 것을 막기 위함).
- `POST /v1/releases` — deprecated 버전으로는 `400 validation-error` 반환. 기존 릴리스의 status 조회는 무관.

### 6.3 UI state 저장 포맷

Plan 1 엔드포인트 한 개(`POST /v1/templates` + `PUT /v1/templates/:name/versions/:v` 가 Plan 2 에서 신설되면)가 `ui_state_json` 을 받는다. 서버는:

1. `ui_state_json` → `resources.yaml` + `ui_spec.yaml` 직렬화 (백엔드 측에서 수행, 프런트 믿지 않음).
2. 직렬화 결과를 Plan 1 render 파이프라인으로 `Render()` 해서 dry-run 검증.
3. 검증 통과 시 `template_versions` 에 3 개 모두 저장 (`ui_state_json`, `resources_yaml`, `ui_spec_yaml`).

직렬화기의 장단점:
- **장점**: 클라이언트가 손상된 상태를 보내도 YAML 은 서버가 만든 결정적 형태.
- **단점**: 백엔드와 프런트 둘 다 같은 스키마 형상을 이해해야 함 → 단일 Go 타입을 source of truth 로 두고 TS 타입은 codegen 검토 (MVP 는 수동 동기화 OK).

---

## 7. 프런트엔드 변경

### 7.1 새 페이지

| 경로 | 내용 |
|------|------|
| `/templates/new?mode=ui` | UI 에디터 (스키마 fetch → 트리 편집 → live YAML preview → 메타 → 저장) |
| `/templates/:name/versions/:v/edit?mode=ui` | 기존 UI 버전 편집 |
| `/admin/teams` | 팀 목록 (admin) |
| `/admin/teams/:id` | 팀 상세 + 멤버 관리 |

### 7.2 기존 페이지 변경

- `/templates/:name` — 버전 목록에 `deprecated` 상태 배지, `(Un)Deprecate` 버튼. `authoring_mode` 에 따라 "UI 로 편집" 또는 "YAML preview (legacy)" 버튼 구분.
- `/catalog` — 카탈로그 필터에서 deprecated 버전을 자동 제거 (서버가 이미 필터).
- `/templates/new` — 기본 진입은 UI 모드. 고급 옵션으로 YAML 모드 (Plan 1 동작 그대로, 숨김).

### 7.3 새 컴포넌트

- `SchemaTree` — openapi 응답을 파싱해 재귀 렌더. 필드 클릭 시 `FieldInspector` 에 선택값 전달.
- `FieldInspector` — "고정 / 노출" 토글 + 타입별 입력 + ui-spec 메타 폼.
- `KindPicker` — `/openapi` 응답에서 kind 목록 추림 (core + apps/v1 + batch/v1 + CRD).
- `YamlPreview` — Monaco read-only. `ui_state_json` 변경 시 **300ms debounce 후 `POST /v1/templates/preview` 호출** 하여 서버가 직렬화한 YAML 을 표시. 클라이언트측 직렬화기는 두지 않음 (직렬화 로직 single source of truth: Go 백엔드).

---

## 8. 확정된 결정 (v0.1 의 미결 4건)

v0.1 §8 에 남겨둔 4 개 질문은 2026-04-18 브레인스토밍에서 아래와 같이 확정되었다. 각 항목은 이 문서의 해당 섹션에 이미 반영되었으며, 결정 근거는 기록 목적으로만 여기에 남긴다.

### 8.1 Live YAML preview 직렬화 주체 → **서버 preview 엔드포인트 (B)**

→ 반영: §7.3 `YamlPreview` 컴포넌트, §6.1 신규 엔드포인트 `POST /v1/templates/preview`

근거: 직렬화 로직을 Go 한 곳에만 두면 클라/서버 drift 위험이 사라진다. 300ms debounce 로 network round-trip 체감 작고, 오프라인 편집은 Plan 2 유즈케이스 아님.

### 8.2 UI state 의 `clusterName` 저장 여부 → **저장 안 함 / 세션 로컬 힌트만 (B)**

→ 반영: §4.2 `UIModeTemplate` 타입 주석

근거: 대부분 템플릿이 core 리소스라 클러스터 간 차이 없음. CRD 불일치는 apply 시점의 "resource not found" 로 충분히 명확. 저자 클러스터 고정은 false-positive 경고를 낳고 재배포 유연성만 깎음.

### 8.3 팀 관리 UI → **Plan 2 에 포함 (A)**

→ 반영: §7.1 `/admin/teams`, `/admin/teams/:id` 페이지

근거: 팀 기반 권한 모델이 Plan 2 데이터 스키마에 들어가는데 UI 가 없으면 브라우저 검증이 안 됨. 프런트 작업량도 리스트 1 + 상세 1 + 모달 2 로 적음.

### 8.4 스키마 fetch 인증 → **유저 id_token 포워딩 (A)**

→ 반영: §4.1 파이프라인 인증 단계

근거: Plan 1 의 "앱은 UX 레이어, 모든 k8s 콜은 유저 토큰" 원칙 일관성. 앱 SA 도입하면 다른 기능에서도 타협 유혹 생김. RBAC 별 응답 차이를 user 별 캐시로 자연스럽게 흡수.

---

## 9. 출시 전 반드시 검증

- Plan 1 레거시 템플릿을 여전히 정상 배포·삭제 가능 (`authoring_mode='yaml'` 경로).
- 글로벌 템플릿 (owning_team_id null) 은 `kubeport-admin` 만 편집 가능, 일반 유저는 열람 가능.
- 팀 멤버십 조작 시 세션 그대로에서 즉시 반영 (다음 API 호출부터 권한 변경 적용).
- Deprecated 버전으로 `/v1/releases` POST 하면 400.
- Openapi fetch 가 큰 클러스터(CRD 수백 개)에서 타임아웃 없이 완료 (스트리밍·페이지네이션이 아닌 단일 응답 감당 가능한지).
- Plan 1 의 모든 e2e 테스트 통과.

---

## 10. Out of scope — Plan 3 이후

- 템플릿 버전 diff 뷰, 감사 로그.
- 승인 워크플로 (draft → review → publish).
- 팀 초대·가입 요청 승인 UI.
- 릴리스의 팀 소유 개념, 네임스페이스 ↔ 팀 매핑.
- 팀 단위 카탈로그 가시성.
- Helm 차트 임포트를 UI 모드로 올리기.
- Git-backed 템플릿 저장소.

---

## 변경 이력

- **v0.1 (2026-04-18)** — 초안.
