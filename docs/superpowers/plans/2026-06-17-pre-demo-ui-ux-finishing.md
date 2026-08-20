# 데모 전 UI/UX 마감 — 리뷰 findings (2026-06-17)

> **Status**: 📝 review findings (실행 전 백로그). Plan 10 (GCP Phase 1 — 첫 사용자 데모 URL) **전에** 처리할 UI/UX 마감 항목.
> **출처**: 2026-06-17 AI 코드 기반 UI/UX 리뷰 (리뷰어 2명 — ① 화면별 UX 흐름 / ② 디자인 시스템·접근성). Docker 데몬이 꺼져 있어 **라이브 스크린샷은 못 찍었고**, JSX/TSX·토큰·i18n 메시지를 읽은 **구조적 리뷰**다. 픽셀 단위 폴리시(여백·타이포·대비 미세조정)는 스택 기동 후 라이브 스크린샷으로 별도 확인한다 (→ 부록 B).
> **번호**: 기존 Plan 시리즈를 재배치하지 않는다. 이 문서는 Plan 9(Helm)·Plan 10(데모) 와 직교하는 **마감 백로그**이며, 데모 대상 화면 품질을 Plan 10 전에 끌어올리는 것이 목적.

## 한 줄 요약

엔지니어링은 꼼꼼한데(디바운스 프리뷰, RBAC 프리플라이트, draft/publish 게이팅, stale-release 회수), **마감이 "두 등급"으로 갈라져 있다.**

- ✅ **Plan 7에서 리프레시한 화면** (AppShell·카탈로그·릴리스 리스트·stale 배너) — 토큰 깔끔 + i18n 완비 + empty/error 상태 처리.
- ⚠️ **그 외** (배포 폼·어드민 에디터·릴리스 상세·팀 관리) — 하드코딩 한국어 + raw 백엔드 에러 덤프 + loading/empty/error·확인(confirm) 처리 누락.

**이 갈라짐이 정확히 Plan 10 목표("동료가 데모 URL을 만져본다")를 때린다** — 첫 사용자가 만질 화면(배포 폼)이 하필 마감 안 된 쪽이다.

---

## P0 — 데모 전 필수 (Critical) 🔴

첫 사용자가 "쓸만해 보인다 vs 깨진 것 같다"를 가르는 선. Plan 10 전에 반드시 처리.

| # | 화면 | 위치 | 문제 | 픽스 |
|---|------|------|------|------|
| C1 | 배포 폼 | `app/catalog/[name]/deploy/DeployClient.tsx:187-260`, `components/RBACCheckPanel.tsx:89-110`, `components/ResourcesPreview.tsx:32-35` | 가장 중요한 **사용자 화면이 통째로 하드코딩 한국어** — next-intl 우회. 로케일 토글이 이 화면에서 무력화. | `messages/{en,ko}.json` 에 `deploy` 네임스페이스 신설 후 추출. |
| C2 | 배포 폼 | `DeployClient.tsx:173-174, 256-258` | **제출 실패 시 raw 백엔드 에러 문자열 노출** — 403 RBAC 거부/422 k8s 검증 에러가 Go/JSON 덩어리로 비전문가 앞에 표시. | 상태코드 매핑(403→"권한 없음", 409→"이름 중복", 422→필드 에러) + 원문은 "자세히" disclosure 뒤로. |
| C3 | 배포 폼 | `DeployClient.tsx:153-171, 156` | **이중 제출 버그** — 제출 중 버튼이 disabled 안 됨(`disabled` 만 체크, `submitting` 누락) → 릴리스 2개 생성 가능. 성공 피드백도 14px 회색 "처리 중…" 한 줄뿐. | `disabled={disabled || submitting}` + 버튼 스피너 + 도착 페이지 성공 토스트. |
| C4 | 어드민 상세 | `app/templates/[name]/page.tsx:142-162` | **파괴적 액션에 확인 없음** — `삭제`/`Deprecate`/`Undeprecate`/`Publish` 가 클릭 즉시 server action 실행, 실패 시 에러 바운더리로 throw. | confirm 다이얼로그 (이미 `ForceDeleteButton` 에 `forceDelete.confirm` 패턴 존재 — 재사용). |
| C5 | 어드민 에디터 | `app/templates/[name]/versions/[v]/edit/page.tsx` 전반 | 에디터 **전체가 하드코딩 한국어 + raw 에러 덤프** (`setErr(\`${res.status}: ${await res.text()}\`)` @249,435). | C1 과 함께 i18n 추출 + 에러 매핑. |

## P1 — 신뢰도 갭 (Major) 🟡

데모는 가능하나 "끊기면 깨진 것처럼 보임". P0 직후 처리 권장.

| # | 화면 | 위치 | 문제 | 픽스 |
|---|------|------|------|------|
| M1 | 카탈로그 | `app/catalog/page.tsx:17` | 에러 상태 없음 — `throw new Error(...)` 가 generic Next.js 에러 바운더리로. 랜딩 화면이 백엔드 한 번 끊기면 흰 에러 페이지. | "다시 시도" 패널로 graceful degrade (`releases/page.tsx:8` 처럼). |
| M2 | 릴리스 상세 | `releases/[id]/page.tsx:20`, `logs/page.tsx:12`, `layout.tsx:32` | 모든 fetch 실패가 `notFound()` → 일시적 5xx가 "404 없음"으로 표시. | 404 vs 5xx 구분, 5xx 는 재시도 패널. |
| M3 | 릴리스 상세 | `releases/[id]/page.tsx:29-30`, `MetricCards.tsx:24-25` | `memory`/`accessURL` 이 `null` 하드코딩 → 모든 릴리스가 영구 "—". "미구현"인지 "데이터 없음"인지 구분 불가. | 미배선이면 카드 제거, 아니면 "측정 안 됨" 라벨. |
| M4 | 릴리스 로그 | `LogsPanel.tsx:164-179, 196` | 첫 줄 전 검은 빈 박스(플레이스홀더 없음) + 끊김 시 재연결 버튼 없음(스트림 재시도 안 함). 비전문가에겐 "고장". | "로그 대기 중…" 플레이스홀더 + 재연결 버튼. |
| M5 | 배포 폼 | `DeployClient.tsx:196-236` | 메타 입력(이름·클러스터·네임스페이스)에 required 표시·검증 없음 — 이름 비우고 제출 가능(라운드트립 후 백엔드 에러로만 표면화). DynamicForm 필드는 `*` 있음(`DynamicForm.tsx:187`). | 메타 블록에도 `*` + 클라이언트 검증. |
| M6 | 배포 폼 | `RBACCheckPanel.tsx:100-110`, `DeployClient.tsx:265` | "denied" 상태에 다음 행동 안내 없음(그냥 빨간 줄). 패널이 cluster+namespace 설정 후에만 렌더 → 첫 로드 시 권한 피드백 0. | "관리자에게 권한 요청" 안내 + 거부 시 제출 사전 차단. |
| M7 | 어드민 에디터 | `FieldInspector.tsx:46-54` | "값 고정 / 사용자 노출" 토글에 인라인 도움말 0 — 어드민 멘탈모델의 **중심 개념**인데 설명 부재. | 토글 아래 한 줄 헬퍼("노출 = 사용자 폼에 필드로 나타남"). |
| M8 | 어드민 에디터 | `edit/page.tsx:199`, `BottomBar.tsx:31-36` | `canPublish=false` 고정 → BottomBar 의 Publish 버튼 영구 비활성, 안내 없음. 클릭해도 무반응 = dead-end. | 숨기거나 "퍼블리시는 상세 페이지에서" 툴팁. |
| M9 | 어드민 에디터 | `edit/page.tsx:256` | 로드 실패 시 전체 화면이 빨간 한 줄로 교체(헤더·탭·재시도·뒤로 없음). | 에러 패널 + 뒤로/재시도. |

## P2 — 디자인 시스템 부채 (Minor / 누적 전 정리) 🟢

| # | 영역 | 위치 | 문제 | 픽스 |
|---|------|------|------|------|
| D1 | i18n | 23개 파일 137개 하드코딩 한국어 vs 12개 파일만 next-intl | en 선택 시 앱 대부분이 한국어로 남음. **키 parity는 완벽(39/39)** — 문제는 coverage. 사실상 *기능 버그*(en 로케일 깨짐). | 어드민/에디터/배포/로그/탭/팀 surface i18n 추출. C1·C5 가 큰 덩어리. |
| D2 | 토큰/dark | 45개 raw 팔레트 색 (`RoleBadge`, 템플릿 페이지 `green-100`/`yellow-100`, `edit` `bg-amber-50`/`bg-green-600`, `LogsPanel` `slate-50` 등) | 다수가 dark 변형 없음. | `text-destructive`/`Badge`/`StatusChip` variant 로 교체. |
| D3 | 일관성 | 상태/역할 색이 **3곳 중복 정의** (`badge.tsx` / 템플릿 페이지 인라인 / `LogsPanel` dots), `RoleBadge` 독자 팔레트 | `statusChipVariantFromRelease`(`StatusChip.tsx:26`) 이미 존재하나 일부만 사용. | 단일 status→variant 맵으로 일원화. |
| D4 | a11y | `<th scope>` 0개(12개 중), 아이콘 버튼 `aria-label` 4개뿐 | 스크린리더 헤더-셀 연결 불가. | `scope="col"` 추가, 아이콘 전용 버튼 `aria-label`(i18n). |
| D5 | a11y/대비 | `--muted-foreground`(L0.556) on `--background`(L0.97) ≈ AA 경계선; `text-primary`(L0.55) 링크 ≈ 4.5:1 경계 | 보조 텍스트·링크 대비 위험. | light `--muted-foreground` 를 ~L0.50 로, `text-primary` 대비 검증. |
| D6 | 반응형 | `ReleaseTable.tsx:24` 가 `overflow-hidden`(not `overflow-x-auto`) | 좁은 화면에서 컬럼 뭉개짐(스크롤 안 됨). 에디터 `ResizablePanelGroup` 도 <768px 확인 필요. | 테이블 래퍼 `overflow-x-auto`. |
| D7 | 일관성 | raw `<button>` (에디터 저장·deprecate·publish) vs shadcn `Button`, `LocaleSwitch` raw `<select>` vs `ui/select`, 하드코딩 radius(`rounded` vs `--radius` 1rem) | 디자인 시스템 이탈로 시각 불일치. | shadcn 컴포넌트·radius 스케일로 통일. |

### 깨끗한 부분 (재지적 방지)

- TSX 에 raw hex 색(`text-[#...]`) **0개**.
- i18n 키 parity **완벽** (en 39 / ko 39, drift 0) — 문제는 coverage 지 drift 아님.
- `lang={locale}` 정상(`app/layout.tsx:34`), 프리미티브(`button.tsx`/`badge.tsx`) `focus-visible:ring` + `aria-invalid` 완비.
- 모바일 사이드바·로케일 select 는 `aria-label` 있음. 카탈로그 그리드 `auto-fit minmax` 반응형 OK.

---

## 내일 작업 TODO (다음 세션 — 다른 PC)

> 2026-06-17 작성. 내일 **다른 PC** 에서 재개 예정 → 이 TODO 는 git 에 커밋되어 있어야 다른 기기에서 뜬다 (auto-memory 는 머신 종속이라 안 불러와짐). CLAUDE.md "현재 단계" 에도 포인터 박아둠.

- [ ] **0. (재개 직후) 이 브랜치 체크아웃** — `git fetch origin && git checkout docs/pre-demo-ui-ux-review` (또는 PR #41 머지 후 main). 그래야 CLAUDE.md 의 다음-세션 포인터 + 이 문서가 보임.
- [ ] **1. Docker 켜고 로컬 스택 기동** — `docs/local-e2e.md` §4–10. 라이브 화면 검증의 전제. (오늘 이게 안 돼서 코드 기반 리뷰만 됨.)
- [ ] **2. (권장) AI 검증 인프라 먼저** — 부록 B 의 **B1(dev 인증 우회) + B4(원커맨드 데모 스택)**. 이후 모든 UI 작업을 라이브로 검증 가능. Plan 11 e2e 와 합치는 방향.
- [ ] **3. P0(🔴) TDD 픽스** — 아래 순서:
  - [ ] C1·C2·C3 — 배포 폼 (i18n `deploy` 네임스페이스 / 에러 매핑 / 이중 제출·성공 토스트). 한 화면이라 묶어서.
  - [ ] C4 — 어드민 상세 파괴적 액션 confirm 다이얼로그.
  - [ ] C5 — 어드민 에디터 i18n + 에러 매핑.
- [ ] **4. P1(🟡)** — M1·M2(카탈로그/릴리스 에러 상태) 우선, 나머지 시간 되는 대로.
- [ ] **5. 라이브 픽셀 폴리시** — 스택 떠 있으면 4화면 스크린샷 받아 부록 A 항목 확인.

> 데모 대상이 **영어권 포함**이면 D1(i18n coverage) 을 P0 로 승격. 한국어권만이면 후순위 OK.

---

## 권장 실행 순서 (내일)

1. **P0 5개** (C1~C5) — 데모 차단 항목. 배포 폼이 최우선(C1·C2·C3 한 화면).
2. **M1·M2** (카탈로그/릴리스 에러 상태) — 첫 화면 신뢰도.
3. 나머지 P1, 그다음 P2.
4. **데모 대상이 한국어권이면** D1(i18n) 후순위 OK. 영어권 섞이면 D1 을 P0 로 승격.

각 항목 TDD 로: 실패 테스트(playwright 또는 컴포넌트) → 픽스 → 통과.

---

## 부록 A — 미커버 영역

- **픽셀 폴리시** (여백·타이포 스케일·실제 렌더 대비·hover/focus 모션): Docker 미기동으로 라이브 스크린샷 못 찍음. 부록 B 셋업 후 별도 라운드.
- **실제 RBAC 거부/클러스터 끊김/drift 회수 플로우의 시각 확인**: 라이브 스택 필요.

## 부록 B — AI 자율 테스트/리뷰를 위한 셋업 (제안)

이번 리뷰가 코드 기반에 그친 근본 원인은 **AI가 화면을 띄워볼 수 없어서**다. 막힌 지점:

1. **Docker 데몬 꺼져 있음** (WSL 통합/Docker Desktop 미기동).
2. **OIDC(dex) 인증 필수** — 모든 페이지가 `apiFetch` → Bearer 토큰 요구(`lib/api-server.ts`). 세션 없으면 렌더 불가.
3. **시드 데이터 없음** — published 템플릿·릴리스가 없으면 카탈로그·상세가 빈 화면.
4. **~30분 머신 종속 셋업** (kind + dex cert, `docs/local-e2e.md`).

→ AI(또는 CI)가 **헤드리스로 4개 화면을 자동 스크린샷 → 비전 리뷰**하게 하려면 다음이 필요 (Plan 11 e2e 확장과 합치는 것을 권장):

- **B1. dev 인증 우회 모드** — `E2E_BYPASS_AUTH=1` 같은 플래그로 dex 없이 고정 토큰/스텁 세션 주입. 프로덕션 빌드에서는 절대 활성화 안 되도록 가드. → 인증이 최대 블로커이므로 최우선.
- **B2. 시드 픽스처** — published 템플릿 2~3개 + 릴리스 1개를 한 번에 넣는 스크립트/마이그레이션 (현재 `local-e2e.md §9` 수동 절차를 코드화).
- **B3. 스크린샷 스펙** — 기존 `frontend/tests/e2e/` playwright 하니스에 "4개 화면 + ko/en 토글 캡처 → `artifacts/screenshots/`" 스펙 추가. `playwright.config.ts` 는 현재 `screenshot: only-on-failure` 라 항상 캡처하는 별도 프로젝트/스펙 필요.
- **B4. 원커맨드 데모 스택** — `make demo-up` (또는 compose profile)이 backend+postgres+시드+B1 우회까지 한 번에. kind/dex 없이 뜨게 해 머신 종속성 제거.
- **B5. AI 리뷰 진입점** — 위가 갖춰지면 비전 가능 에이전트가 PNG 폴더를 읽어 픽셀/레이아웃 리뷰. CI 에서 PR 마다 스크린샷 아티팩트를 올리면 사람 리뷰도 빨라짐.

우선순위: **B1 → B2 → B4 → B3 → B5.** B1+B2+B4 만 되어도 AI 가 로컬에서 화면을 띄워 자율 리뷰가 가능해진다.
