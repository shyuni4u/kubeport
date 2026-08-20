# kubeport Frontend — 디자인 스펙 v0.1

| | |
|---|---|
| 버전 | 0.1 |
| 날짜 | 2026-04-19 |
| 범위 | 4 화면 (Admin UI 에디터, User 카탈로그, User 배포 폼, User 릴리스 상세) |
| 선행 문서 | [초기 디자인](2026-04-16-initial-design.md), [Plan 2 Admin UX](2026-04-18-plan2-admin-ux-design.md) |

이 문서의 역할: **구현 타겟을 못 박는 단일 소스**. 픽셀 단위 디자인 가이드가 아니라 "어떤 컴포넌트를 쓰고, 어떤 레이아웃으로 배치하고, 어떤 상태를 관리하는지"를 Claude Code가 섹션별로 읽고 작업할 수 있게 정리.

---

## 0. 전제

- 스택: Next.js 15 App Router · Tailwind · shadcn/ui · Monaco (YAML) · React Hook Form + Zod
- 기존 `frontend/app/` 구조 유지 (초기 디자인 §5.5)
- Plan 1 이 머지된 상태라고 가정. 일부 화면(카탈로그 / 배포 폼 / 릴리스 상세)은 이미 존재할 수 있고, 이 스펙은 **리디자인 타겟**. Admin UI 에디터는 Plan 2 신규.

---

## 1. 공통 디자인 토큰

### 1.1 Role badge — 모든 화면 상단 바 우측 고정

| 롤 | 배경 | 텍스트 | 레이블 |
|---|---|---|---|
| Admin | `bg-purple-50` / `#EEEDFE` | `text-purple-800` / `#3C3489` | "Admin · 템플릿 작성" |
| User | `bg-teal-50` / `#E1F5EE` | `text-teal-800` / `#085041` | "User · 카탈로그 소비" |

스타일: `px-2.5 py-0.5 rounded-full text-[11px] font-medium`

구현: `components/role-badge.tsx`
```tsx
type Props = { role: "admin" | "user"; withLabel?: boolean }
```
세션 유저의 `groups` 클레임에 `kubeport-admin` 포함 여부로 자동 결정. Admin 화면으로 User 가 진입하면 서버에서 403 이지만, 클라이언트 가드도 겸함.

### 1.2 Status chip

shadcn `Badge` variant 확장:

| variant | 용도 |
|---|---|
| `success` (green) | 릴리스 정상, 버전 published |
| `warning` (amber) | 배포 중, draft, 업데이트 가능 |
| `danger` (red) | 실패 |
| `muted` (gray) | deprecated |

구현: `components/status-chip.tsx`. 내부에서 shadcn `Badge` 를 wrap.

### 1.3 Monaco 코드 패널

- 다크 테마 고정 (`vs-dark`), 배경 `#1e1e1e`
- **Next.js 15 App Router 에서는 `dynamic` + `ssr: false` 필수** (Monaco 가 `window` 참조)
- read-only 모드와 edit 모드 prop 으로 분기
- YAML 신택스 하이라이팅: Monaco 빌트인 (`@monaco-editor/react` 기본 포함)

```tsx
// components/monaco-panel.tsx
"use client"
import dynamic from "next/dynamic"
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false })

export function MonacoPanel({ value, readOnly = false, onChange, language = "yaml" }) { ... }
```

### 1.4 Breadcrumb

shadcn `Breadcrumb` 그대로. 모든 내부 페이지 상단.

### 1.5 색상 토큰 참고 (Tailwind 기본 팔레트 매핑)

| 용도 | Tailwind | hex |
|---|---|---|
| Primary action | `blue-700` | `#185FA5` |
| Success | `teal-800` | `#085041` |
| Warning | `amber-800` | `#633806` |
| Danger | `red-700` | `#A32D2D` |
| Info / highlight | `blue-500` | `#378ADD` |

---

## 2. 공통 레이아웃

### 2.1 AppShell

`components/app-shell/top-bar.tsx` — 모든 로그인 후 페이지의 공통 상단 바.

구조 (왼쪽 → 오른쪽):
1. 로고 "kubeport"
2. 네비게이션 탭: (User) `카탈로그` · `내 릴리스` / (Admin) `Templates` · `Releases` · `Clusters` · `Teams`
3. 선택사항: Breadcrumb 은 페이지별로 top-bar 아래 별도 영역
4. 오른쪽: 유저 이메일 + RoleBadge + DropdownMenu (로그아웃)

### 2.2 페이지 래퍼

`app/(app)/layout.tsx` 에서 AppShell 배치. `/auth/*` 는 이 래퍼 바깥.

---

## 3. 화면 1: Admin — UI 모드 템플릿 에디터

### 3.1 Route

- `app/templates/new/page.tsx` — `?mode=ui` 쿼리로 분기
- `app/templates/[name]/versions/[v]/edit/page.tsx` — `?mode=ui`

`?mode=yaml` 은 Plan 1 YAML 에디터로 fallback.

### 3.2 레이아웃

```
┌── Top bar (kubeport / Templates / web-service · [v2 draft]) ·················· [Admin]
├── Meta row (name · team · tags)
├── ResizablePanelGroup (horizontal)
│   ├── Panel 1: SchemaTree
│   ├── ResizableHandle
│   ├── Panel 2: FieldInspector
│   ├── ResizableHandle
│   └── Panel 3: YamlPreview (Monaco read-only, 다크)
└── Bottom bar (미리보기 · Draft 저장 · Publish)
```

### 3.3 컴포넌트 인벤토리

| 컴포넌트 | 종류 | 경로 | 주요 prop |
|---|---|---|---|
| ResizablePanelGroup | shadcn | `components/ui/resizable.tsx` | — |
| SchemaTree | 커스텀 | `components/template-editor/schema-tree.tsx` | `resources, selectedPath, onSelect` |
| KindPicker | 커스텀 | 동상 | `availableKinds, selectedKinds, onAdd` |
| FieldInspector | 커스텀 | `components/template-editor/field-inspector.tsx` | `field, onChange` |
| YamlPreview | 커스텀 | `components/template-editor/yaml-preview.tsx` | `resourcesYaml, uiSpecYaml, tab` |

SchemaTree 내부 아이템:
- "고정" 배지 (회색) / "● exposed" 배지 (blue-50 / blue-800)
- 선택 시 해당 행에 `bg-blue-50 border-l-2 border-blue-500` 하이라이트
- 접기/펼치기 상태 컴포넌트 내부 관리 (트리 깊이 1-5 level)

FieldInspector 내부:
- shadcn `Tabs` (세그먼트 스타일) 로 "값 고정" / "사용자에게 노출" 전환
- "노출" 탭 내용: shadcn `Input` × 2 (label / help), `Select` (type), `Input type=number` × 3 (min/max/default), `Checkbox` (required)
- Type 별 조건부 필드: `enum` 선택 시 values 입력용 `Input` 리스트

### 3.4 상태

```ts
type UIModeTemplate = { resources: Resource[]; ... }  // Plan 2 §4.2 참조
type SelectedPath = { kindIndex: number; jsonPath: string } | null

// 단일 에디터 세션이라 useState 로 충분
const [state, setState] = useState<UIModeTemplate>(initial)
const [selected, setSelected] = useState<SelectedPath>(null)
const [previewYaml, setPreviewYaml] = useState<{ resources: string; uiSpec: string }>()
```

Zustand 로 올릴 필요 없음. 상태가 자식까지 prop drilling 되지만 깊이 2 수준.

### 3.5 데이터 흐름

1. **초기 로드**: `GET /v1/clusters/:name/openapi` → kind 목록 (KindPicker)
2. **Kind 추가**: `GET /v1/clusters/:name/openapi/:gv` → 해당 GV 스키마 → SchemaTree 렌더
3. **필드 편집**: `state` 업데이트 → **300ms debounce** → `POST /v1/templates/preview` → `previewYaml` 갱신
4. **저장**: `POST /v1/templates` (신규) 또는 `PUT /v1/templates/:name/versions/:v` (draft 수정)
5. **Publish**: `POST /v1/templates/:name/versions/:v/publish`

Debounce 구현: `useDebouncedCallback` (`use-debounce` 패키지) 또는 직접 `setTimeout`.

TanStack Query 로 감싸는 걸 추천:
- `useQuery` for openapi fetch (stale 60분, user 별 key)
- `useMutation` for preview / save / publish

### 3.6 Acceptance criteria

- [ ] User 롤로 진입 시 서버가 403, 클라도 RoleBadge 로 차단 안내
- [ ] 3 pane 모두 리사이즈 가능, 최소 너비 220px
- [ ] 선택된 필드가 트리 · 인스펙터 · YAML 세 곳에 동시 하이라이트 (blue ramp)
- [ ] YAML 미리보기는 read-only
- [ ] 저장 전 draft 상태에 머묾. Publish 버튼은 `resources_yaml` 검증 통과 시에만 enable
- [ ] 메타 필드 (name, team, tags) 변경도 draft 저장 대상

---

## 4. 화면 2: User — 카탈로그

### 4.1 Route

`app/catalog/page.tsx`

### 4.2 레이아웃

```
┌── Top bar ·························································· [User]
├── 페이지 헤더 ("카탈로그" + 설명 + 검색 Input 오른쪽 정렬)
├── 태그 필터 (ToggleGroup, 첫 번째 "전체" 선택)
└── CardGrid (auto-fit, minmax(190px, 1fr), gap 10px)
    └── CatalogCard × N
```

### 4.3 컴포넌트

| 컴포넌트 | 경로 | prop |
|---|---|---|
| CatalogCard | `components/catalog/catalog-card.tsx` | `template: TemplateListItem` |
| 태그 필터 | inline, shadcn `ToggleGroup` (type="single") | — |

CatalogCard 내부:
- 아이콘 (lucide-react, 색 배경 30×30 rounded-md)
- 타이틀 (`display_name`, 14px / 500)
- 설명 (12px / text-secondary, `line-clamp-2`, min-height 36px 로 카드 높이 통일)
- 태그들 (shadcn Badge variant=secondary, 10px)
- 하단: "v2 · platform" + "배포하기 →" (링크)
- 클릭 → `router.push('/catalog/${template.name}/deploy')`

### 4.4 데이터

- `GET /v1/templates?status=published` — TanStack Query
- 검색 + 태그 필터: 클라이언트 측 (템플릿 수가 수백 개 넘기 전까진 OK, Plan v1.1 에서 서버 페이지네이션)

### 4.5 Acceptance

- [ ] Deprecated 버전은 서버가 이미 필터, 클라 재확인 불필요
- [ ] 빈 상태 (템플릿 0개) UI: 일러스트 + "관리자가 아직 템플릿을 만들지 않았습니다"
- [ ] 검색은 `display_name` + `description` 대상, 태그 필터와 AND 결합
- [ ] 아이콘은 템플릿 `tags[0]` 또는 metadata.icon 으로 결정 (매핑 테이블 `lib/template-icons.ts`)

---

## 5. 화면 3: User — 배포 폼

### 5.1 Route

- `app/catalog/[name]/deploy/page.tsx` — 최신 published 버전 사용
- `app/catalog/[name]/versions/[v]/deploy/page.tsx` — 특정 버전 고정 (업데이트 플로우)

### 5.2 레이아웃

```
┌── Top bar (···· / 카탈로그 / Web Service) ············ [User]
├── 2-col grid (1fr : 0.85fr)
│   ├── 좌: 폼
│   │   ├── "새 배포" + "Web Service · v2 · platform 팀"
│   │   ├── 2-col (릴리스 이름 / 클러스터)
│   │   ├── 네임스페이스
│   │   ├── Separator + "템플릿 옵션" 소제목
│   │   └── DynamicForm (ui-spec 기반 동적 필드)
│   └── 우: 미리보기 패널 (tertiary bg)
│       ├── "만들어질 리소스" 리스트
│       ├── "권한 확인" 카드 (success / danger)
│       └── 보조 문구
└── 하단 우측: 취소 / 배포하기 버튼
```

### 5.3 DynamicForm — 핵심 추상화

ui-spec 엔트리 1개 ↔ 폼 필드 1개. 타입별 컴포넌트 매핑:

| `type` (ui-spec) | 컴포넌트 | 조건 |
|---|---|---|
| `string` | shadcn `Input` | `pattern` 있으면 inline 표시 |
| `integer` | shadcn `Slider` | `min && max` 둘 다 있을 때 |
| `integer` | shadcn `Input type=number` | min/max 둘 중 하나라도 없을 때 |
| `boolean` | shadcn `Switch` | — |
| `enum` | shadcn `ToggleGroup` (single) | `values.length ≤ 4` |
| `enum` | shadcn `Select` | `values.length > 4` |

### 5.4 Zod 스키마 런타임 생성

`lib/ui-spec-to-zod.ts`:

```ts
export function schemaFromUISpec(uiSpec: UISpec): ZodObject<...> {
  const shape = {}
  for (const field of uiSpec.fields) {
    let zs: ZodTypeAny
    switch (field.type) {
      case "string":
        zs = z.string()
        if (field.minLength) zs = zs.min(field.minLength)
        if (field.maxLength) zs = zs.max(field.maxLength)
        if (field.pattern)   zs = zs.regex(new RegExp(field.pattern))
        break
      case "integer":
        zs = z.number().int()
        if (field.min !== undefined) zs = zs.min(field.min)
        if (field.max !== undefined) zs = zs.max(field.max)
        break
      case "boolean": zs = z.boolean(); break
      case "enum":    zs = z.enum(field.values as [string, ...string[]]); break
    }
    if (!field.required) zs = zs.optional()
    shape[pathToKey(field.path)] = zs
  }
  return z.object(shape)
}
```

폼 초기화:
```ts
const uiSpec = parseUiSpec(template.ui_spec_yaml)
const schema = useMemo(() => schemaFromUISpec(uiSpec), [uiSpec])
const form = useForm({
  resolver: zodResolver(schema),
  defaultValues: defaultsFromUISpec(uiSpec),
})
```

### 5.5 데이터 흐름

1. `GET /v1/templates/:name` → 템플릿 메타 + 최신 ui-spec + resources.yaml
2. `schemaFromUISpec` 으로 Zod 스키마 빌드
3. RHF `watch` + debounce(300ms) → `POST /v1/templates/:name/render` → `ResourcesPreview` 갱신
4. 마운트 시 + 필드 변경 시 → `POST /v1/selfsubjectaccessreview` (Go API proxy) → `RBACCheck` 갱신
5. Submit → `POST /v1/releases` → 성공 시 `router.push('/releases/${id}')`

### 5.6 Acceptance

- [ ] 각 ui-spec 엔트리가 정확히 1개 폼 필드로 렌더
- [ ] 유효성 실패 시 shadcn `FormMessage` 로 필드 아래 표시
- [ ] RBAC 실패 시 배포 버튼 disable + 권한 패널에 원인 표시
- [ ] `pattern` 유효성 통과 표시 (필드 우측 작은 "regex ✓")
- [ ] Enum 값 4개 경계 (3→ToggleGroup, 5→Select) 정확히 동작

---

## 6. 화면 4: User — 릴리스 상세

### 6.1 Route

`app/releases/[id]/page.tsx` + 하위 탭은 중첩 라우트:
- `app/releases/[id]/layout.tsx` (공통 헤더 + 탭 네비)
- `app/releases/[id]/page.tsx` (개요)
- `app/releases/[id]/logs/page.tsx`
- `app/releases/[id]/activity/page.tsx`
- `app/releases/[id]/settings/page.tsx`

### 6.2 공통 헤더 (layout.tsx)

- 릴리스 이름 (mono, 20px/500)
- StatusChip (정상 / 배포 중 / 실패)
- UpdateAvailableBadge (선택적) — "업데이트 가능 · v2 → v3"
- 우측: "원본 k8s 용어 보기" Switch
- 메타 줄: "Web Service v2 · dev / team-beta · 2시간 전 배포"
- Tabs: 개요 · 로그 · 활동 · 설정

### 6.3 개요 탭 (page.tsx)

```
┌── MetricCards (4 × auto-fit): 준비된 인스턴스 / 재시작 / 메모리 / 접근 URL
├── 소제목 "인스턴스 (3)"
├── InstancesTable (shadcn Table)
├── 소제목 "실시간 로그" + SSE 상태 인디케이터
└── LogsPanel (peek, Monaco 다크 또는 단순 <pre>)
```

InstancesTable 컬럼: 인스턴스 ID (mono, secondary) · 상태 · 재시작 · 실행 시작 · [로그 →]

### 6.4 로그 탭 (logs/page.tsx)

- `EventSource('/api/v1/releases/[id]/logs?instance=all')` 구독
- 인스턴스 필터 Select (all / 각 pod)
- Auto-scroll toggle (Switch)
- Clear 버튼
- 메시지 line 포맷: `[time] [instance] [level] message`
- 연결 상태: 연결 중 / 연결됨 / 끊김 (재연결 버튼)

구현 레퍼런스:
```ts
useEffect(() => {
  const es = new EventSource(`/api/v1/releases/${id}/logs?instance=${filter}`)
  es.addEventListener("log", (e) => { setLines(prev => [...prev, JSON.parse(e.data)]) })
  es.onerror = () => setStatus("disconnected")
  return () => es.close()
}, [id, filter])
```

### 6.5 k8s 용어 토글

- 상태: 작은 Zustand 스토어 `stores/kube-terms-store.ts` (세션 단위, persist 안 함)
  ```ts
  { showKubeTerms: boolean, toggle: () => void }
  ```
- ON: 라벨 `인스턴스` → `Pod`, `접근 URL` → `Service DNS`, `재시작` → `Restart count`
- 번역 맵은 `lib/kube-term-map.ts` 로 분리

### 6.6 업데이트 플로우

- UpdateAvailableBadge 클릭 → `/catalog/[name]/versions/[v]/deploy?updateReleaseId=[id]`
- 그 페이지에서는 "배포하기" 대신 "v3 로 업데이트", `POST` 대신 `PUT /v1/releases/:id`
- 기존 값은 form defaultValues 로, 새 필드만 ui-spec defaults 로 채움

### 6.7 Acceptance

- [ ] SSE 연결 상태 실시간 반영 (끊기면 빨간 인디케이터)
- [ ] 삭제는 shadcn `AlertDialog` 로 확인 모달
- [ ] 업데이트 가능 뱃지는 현재 버전 < 최신 non-deprecated published 일 때만
- [ ] "원본 k8s 용어 보기" 토글 상태는 **세션 단위**로만 (페이지 리로드 시 리셋). persist 하면 사용자 레벨 선호도 API 필요 → v1.1 범위

---

## 7. 설치 / 셋업 체크리스트

### 7.1 shadcn/ui 컴포넌트

이미 초기화 (`pnpm dlx shadcn@latest init`) 되어 있다고 가정. 필요한 컴포넌트 일괄 추가:

```bash
pnpm dlx shadcn@latest add \
  card button input select tabs toggle-group radio-group \
  resizable badge separator scroll-area form slider \
  checkbox switch table tooltip alert-dialog dialog \
  breadcrumb dropdown-menu
```

### 7.2 Monaco

```bash
pnpm add @monaco-editor/react
```

Next.js 15 App Router 특이사항:
- Monaco 를 쓰는 파일 최상단에 `"use client"`
- `dynamic(() => import("@monaco-editor/react"), { ssr: false })` 로 import
- `next.config.ts` 에서 별도 설정 불필요 (예전 webpack 설정은 App Router 에서 요즘 필요 없음, 테스트 후 필요 시 추가)

### 7.3 기타

```bash
pnpm add @tanstack/react-query zustand use-debounce
pnpm add react-hook-form @hookform/resolvers zod
pnpm add lucide-react
```

TanStack Query Provider 는 `app/providers.tsx` 에 배치, `app/layout.tsx` 에서 wrap.

> **구현자 메모**: §7 의 패키지 중 상당수는 Plan 1·2 에서 이미 `frontend/package.json` 에 추가되어 있을 가능성이 높다. 구현 첫 스텝에서 `frontend/package.json` 을 읽고 **실제로 빠진 것만** 설치할 것. 중복 add 는 피할 것.

---

## 8. 구현 순서 권장

쉬운 것부터 디자인 토큰을 검증하면서 올라가는 게 좋습니다:

1. **토큰 + 공통 컴포넌트** (하루치): `RoleBadge`, `StatusChip`, `MonacoPanel`, `AppShell` (TopBar 포함)
2. **카탈로그** (하루치): 가장 단순, 기존 API 재사용. 디자인 토큰 첫 실전 적용
3. **릴리스 상세 개요 탭** (1-2일치): Plan 1 에 기존 구현 있을 가능성 높음 → 리디자인 + MetricCard 패턴 확립
4. **릴리스 상세 로그 탭** (하루치): SSE 훅 확립
5. **배포 폼 + DynamicForm** (2-3일치): `schemaFromUISpec` 유틸이 핵심. 단위 테스트 작성 권장
6. **Admin UI 에디터** (3-5일치): 가장 복잡. SchemaTree 재귀 렌더 + FieldInspector + YamlPreview debounce 조합

---

## 9. Claude Code 에 작업 맡기는 법

### 9.1 기본 패턴

한 세션 = 한 화면. 세션이 길어지면 컨텍스트 분산됨.

프롬프트 템플릿:
```
docs/superpowers/specs/2026-04-19-frontend-design-spec.md §3 (Admin UI 모드 템플릿 에디터) 섹션만 읽고 구현해 주세요.

제약:
- 기존 frontend/app/ 구조를 따를 것
- shadcn/ui 컴포넌트만 사용. 없으면 shadcn add 로 설치 후 사용
- 외부 디자인 라이브러리 금지
- TypeScript strict mode 준수
- 기존 API 클라이언트 (lib/api/) 재사용, 타입은 openapi-typescript 가 생성한 것을 import

작업 후:
- pnpm build 로 타입 에러 확인
- pnpm lint 통과 확인
```

### 9.2 큰 화면 분할

Admin UI 에디터처럼 복잡한 화면은 한 번에 말고 서브태스크로:

```
세션 1: SchemaTree 단독 구현 (§3.3 SchemaTree 부분만, Storybook 또는 테스트 페이지에서 동작)
세션 2: FieldInspector 단독 구현
세션 3: YamlPreview + preview API 연결
세션 4: 세 컴포넌트를 ResizablePanelGroup 에 조립 + 페이지 라우트
세션 5: 저장 / Publish 플로우
```

### 9.3 검증 루프

Claude Code 세션 끝에 매번:
```bash
pnpm type-check && pnpm lint && pnpm build
```

실패하면 에러를 Claude Code 에 그대로 paste 해서 수정 요청. 이 루프가 세션 내에서 돌아가면 후속 세션이 깔끔해집니다.

### 9.4 목업과의 대조

Claude Code 에는 목업 이미지가 없으므로, 세션에서 불확실하면:
- 이 문서의 텍스트 설명으로 결정
- 여전히 애매하면 Claude Code 가 주석으로 "UX 의문" 을 남기도록 지시
- 다음 대화 세션 (이 곳) 에서 의문점 목록 취합 → 목업 재확인 → 스펙에 반영

Playwright MCP 가 붙어 있으므로, 실제 렌더링 검증은 dev 서버 구동 후 `browser_snapshot` / `browser_take_screenshot` 으로 스펙 대비 대조할 수 있다. 자동 UX 판정용은 아니고 사람이 한 번 더 보는 보조 수단.

---

## 10. 이 스펙의 소유권

- v0.1 은 초기 드래프트. 구현 중 발견되는 엣지케이스는 같은 PR 에서 이 스펙 업데이트까지 포함할 것 (스펙 없는 구현 변경 금지)
- Plan 2 기본 상수 (enum 경계 4, debounce 300ms, OpenAPI LRU 64) 등은 이 문서와 Plan 2 스펙에서 동시 갱신

---

## 변경 이력

- **v0.1 (2026-04-19)** — 4 개 목업 기반 초안.
