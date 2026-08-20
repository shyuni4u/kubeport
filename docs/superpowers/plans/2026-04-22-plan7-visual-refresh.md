# Plan 7 — Visual Refresh + i18n (2026-04-22)

> **Status**: ✅ merged (PR #28).
> Plan 6(post-MVP stabilization, PR #27) 머지 후 후속. **기능·라우트·백엔드 변경 없음 — 비주얼/레이아웃/디자인 토큰 + 국제화(ko/en)만.**

## 동기

Plan 0–6 으로 기능은 MVP 수준으로 올라왔지만 두 가지 표면적 결함이 남아 있다:

1. **UI 가 구리다.** 현재는 "기본 shadcn + 다크 슬레이트 TopBar + 좁은 max-w-6xl 1-컬럼" 형태. 셀프서비스 포털이라는 제품 정체성 — 즉 **사용자(비전문가)에게 친근하고 관리자(전문가)에게는 정보 밀도가 높은 대시보드** — 가 시각적으로 드러나지 않는다.
2. **모든 사용자향 문자열이 한국어 하드코딩.** 영어권 사용자/데모/스크린샷 시나리오에서 사용할 수 없다.

비주얼 리프레시가 결국 **거의 모든 사용자향 컴포넌트를 건드리므로**, 같은 패스에서 문자열을 i18n 키로 외부화해 `ko` / `en` 두 로케일을 지원한다. 같은 파일을 두 번 여는 걸 피하려는 현실적 판단이고, PR 이 과도하게 커질 조짐이면 **Plan 7a(visual) / 7b(i18n)** 로 쪼갠다(하단 "작업 방법" 참조).

레퍼런스 시안(Figma community 파일, fileKey `nDP3cHNKf5Cjo6F2HU1EVv`, "Project Management Dashboard") 은 비주얼 방향성에 한해 **무드보드**로만 사용.

## 스펙/레퍼런스에서 가져올 것

Figma 시안에서 관찰된 패턴(구현 청사진이 아니라 **무드보드**로 사용):

- **좌측 네비게이션 사이드바** (현재 수평 TopBar 네비를 수직으로 재배치): 아이콘 + 라벨 행, active 항목은 라운드 pill 배경. 하단에 부가 영역(예: 현재 클러스터 요약 카드).
- **밝고 부드러운 팔레트**: 현재 `bg-slate-50 + 다크 헤더` → 미세한 뉴트럴 + warm accent 로 전환. 기존 `RoleBadge` / `StatusChip` 색 의미는 유지하되 톤을 낮춘다.
- **카드 라운드(`rounded-2xl`) + 충분한 여백**: 카탈로그·릴리스 리스트의 테이블/카드 밀도를 완화.
- **섹션 헤더에 카운트 pill + 상태 dot**: "릴리스 — ready/updating/failed" 분류 뷰에 그대로 매핑 가능.
- **아바타 스택 + 메타 행** 패턴: 소유 팀·수정자 표시에 활용.
- **상단바 slim 화**: 검색 + 현재 클러스터 + 알림(후속) + 사용자 메뉴만 남기고 기본 네비는 사이드바로 이전.

가져오지 **않을** 것:
- Kanban 3-컬럼, "Today/Filter" 툴바, "Thoughts Time" 위젯, 코멘트/파일 카운트 — 기능적으로 대응물이 없다.
- Figma 에 나오는 구체적인 폰트·색 hex — shadcn 토큰 시스템으로 번역해 사용.

## 범위(Scope)

**IN — 비주얼**:
- 글로벌 레이아웃 셸 재편 (`frontend/app/layout.tsx` + 신규 `AppShell` 컴포넌트: 좌측 사이드바 + 얇은 탑바 + 메인 영역).
- shadcn/Tailwind 디자인 토큰 조정 (`globals.css` 또는 `tailwind.config` 색·라운드·간격 변수).
- 기존 공용 컴포넌트 비주얼 리프레시 — 기능·prop 인터페이스 유지:
  - `TopBar` → 역할 분리 (Sidebar + 상단 유틸리티바).
  - `CatalogCard`, `ReleaseTable`(→ 카드 그리드 변형 검토), `RoleBadge`, `StatusChip`, `MetricCards`, `ReleaseHeader`.
- 타이포그래피·간격·라운드 일관성 정리.
- 라이트/다크 둘 다 지원하되 MVP 는 라이트 우선 (다크 토큰은 자리만 잡아둠).

**IN — i18n**:
- `next-intl` (App Router 공식 호환) 도입. Server/Client 컴포넌트 양쪽에서 번역 호출 가능.
- 로케일 `ko` (기본) / `en` (보조) 2종. 메시지 파일: `frontend/messages/ko.json`, `frontend/messages/en.json`.
- 모든 사용자향 문자열 외부화 — 버튼 라벨·헤더·에러 메시지·빈 상태 문구·툴팁. `aria-label` 과 `<title>` 포함.
- 로케일 전환 UI: 상단 유틸리티 영역의 드롭다운. 선택값은 httpOnly 아닌 일반 쿠키(`NEXT_LOCALE`)에 저장.
- 라우팅 전략: **쿠키 기반**(path prefix 없음) 기본. 내부 툴 성격상 `/ko/catalog` 식 경로 분기는 과한 복잡도 — 다만 공유 링크에서 로케일 유실 가능성은 열린 질문으로 남김.
- 서버 발행 문자열(백엔드 에러 메시지 등)은 **이번 플랜 범위 밖**. 프런트 클라이언트가 내는 문자열만 외부화.
- 날짜/상대시간 포맷은 `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` 을 얇게 감싼 유틸로 일원화.

**OUT**:
- 신규 라우트·신규 페이지·신규 기능 일절 없음.
- 백엔드·DB·OpenAPI 변경 없음. 백엔드가 내려주는 에러 메시지/alert 텍스트 번역 없음.
- 제3 로케일(일본어·중국어 등) 없음. 구조만 n-개 확장 가능하게.
- 번역 품질 감수·전문 번역 의뢰 없음. 1차 번역은 개발자 본인 + LLM 초안.
- 모바일 반응형 최적화는 최소한만 (사이드바 축소 토글 정도. 풀 반응형은 별도 플랜).
- 접근성 감사는 이 플랜에서 하지 않음 (별도 패스).

## 태스크 (초안 — 내일 상세화)

### T1 — 디자인 토큰 정리

`frontend/app/globals.css` 의 CSS 변수를 kubeport 팔레트로 교체. shadcn 의 `--background` / `--foreground` / `--primary` / `--muted` / `--accent` / `--border` / `--ring` / `--radius` 를 뉴트럴 + warm accent 구조로 재정의. `StatusChip` / `RoleBadge` 의 의미 색(ready=green, updating=amber, failed=red, admin=purple 등)은 토큰으로 분리해 유지.

### T2 — `AppShell` 도입 + TopBar 분해

신규 `frontend/components/AppShell.tsx` — 좌측 Sidebar(네비 + 현재 클러스터 카드) + 상단 Header(검색/알림placeholder/사용자메뉴) + `<main>` 영역. 기존 `TopBar` 는 `Sidebar` + `HeaderUtilities` 로 분해 후 삭제. `NAV_BY_ROLE` 로직은 그대로 이전. `frontend/app/layout.tsx` 의 `max-w-6xl mx-auto` 제약 재검토 — 대시보드는 와이드, 폼은 내용 중심 폭으로 분리.

### T3 — 카탈로그·릴리스 리스트 카드 리프레시

- `CatalogCard`: 아이콘 + 제목 + 태그 + 설명 + 소유 팀 아바타. 라운드·그림자·여백 재조정. 호버 상태 정의.
- `ReleaseTable`: 기본은 테이블 유지하되 행 디자인(상태 dot + 제목 + 메타) 정리. 추후 "상태별 섹션 + 카운트 pill" 그리드 뷰로 토글 가능한지 평가 (이번에는 디자인만, 토글은 별도 플랜).

### T4 — 공용 칩/배지/메트릭 스타일 통일

`RoleBadge`, `StatusChip`, `MetricCards` 의 배경·테두리·텍스트 대비를 새 토큰으로 맞춘다. 사이즈 2종(기본/작음)과 variant 이름을 합의(`subtle` / `solid`).

### T5 — 각 페이지 시각 점검 및 조정

`/catalog`, `/catalog/[name]`, `/templates`, `/templates/[name]`, `/templates/new`, `/templates/[name]/versions/[v]/edit` (UI/YAML 두 모드), `/releases`, `/releases/[id]` (개요·로그 탭), `/admin/teams` 를 브라우저로 하나씩 돌아보며 깨진 간격·정렬·색 대비를 수정. 실제 데이터(Plan 6 local-e2e 환경)로 확인한다. 기능 회귀가 있으면 즉시 멈추고 원인을 기록.

### T6 — 시각 회귀 최소 방어

스냅샷 테스트까지는 과하니, 핵심 컴포넌트(`CatalogCard`, `StatusChip`, `RoleBadge`)의 기존 Vitest 가 여전히 통과하는지만 확인. Playwright e2e 는 라벨/역할 기반이므로 디자인 변경에 대해 견고해야 함 — 깨지면 테스트가 DOM 구조에 너무 결합돼 있다는 신호이므로 원래 테스트를 고친다(구조 유연화). **i18n 관점에서는 테스트가 `getByText("릴리스")` 같은 한국어 리터럴 대신 `getByRole("button", { name: /.../ })` 또는 `data-testid` 를 쓰도록 정리** — 로케일 변경 시 e2e 가 통째로 깨지는 걸 피한다.

### T7 — i18n 스캐폴딩

`next-intl` 설치, `frontend/i18n.ts` + 미들웨어(쿠키에서 로케일 읽기) + `NextIntlClientProvider` 를 `Providers` 에 중첩. 메시지 파일 2개(`ko.json`, `en.json`) 만들고 네임스페이스 설계 — 예: `shell`, `catalog`, `templates`, `releases`, `deploy`, `admin`, `common`. Server 컴포넌트는 `getTranslations()`, Client 는 `useTranslations()`. 날짜 포맷 유틸 `lib/format.ts` 신설 (locale-aware `formatDate` / `formatRelative`).

### T8 — 문자열 외부화

섹션 단위로 진행 (shell → catalog → templates → releases → deploy → admin). 순서가 중요한 이유: shell 을 먼저 해야 이후 페이지 작업 중 레이아웃 문구가 바뀌어도 일관성 유지. `ko.json` 은 현재 하드코딩 한국어를 그대로 옮기고, `en.json` 은 개발자 초안 + LLM 교정. 누락 방지 장치는 둘 중 하나 채택(T9 에서 결정):
- (a) TypeScript 로 메시지 키를 타입화 (`messages.d.ts`)해 미정의 키 컴파일 에러.
- (b) 런타임에 누락 키는 키 문자열 자체를 렌더 + 콘솔 경고.

### T9 — 로케일 토글 UI + k8s 용어 토글과의 관계 정리

상단 유틸리티에 `LocaleSwitch` (ko / en 드롭다운). `document.cookie` 에 `NEXT_LOCALE` 저장 후 `router.refresh()`. 기존 `KubeTermsToggle` 과 중첩되는 축(언어 vs. 사용자-친화/기술-원시)이 생기므로, 같은 헤더에 두되 **명확히 분리된 컨트롤** 로 표기 — 예: `Language: 한국어 ▾` / `Terms: Friendly ▾`. 두 토글의 조합이 4가지이나 실제 사용자 문구는 "로케일 × 용어셋" 2차원 룩업 테이블로 처리(`t("releases.title", { terms })` 형태 또는 네임스페이스 분리).

## 작업 방법

- 별도 브랜치 `feat/plan7-visual-refresh` (또는 워크트리) 에서 진행. Plan 6 처럼 단일 PR 목표 — 단, **PR diff 가 과도하게 커지면(예: 변경 파일 40+ 혹은 +2000 라인 초과) 중단하고 `feat/plan7a-visual` / `feat/plan7b-i18n` 로 분리**. 분리 시에는 visual 먼저 머지 → i18n 위에서 외부화하는 순서가 충돌이 적다(토큰/레이아웃이 먼저 고정되어야 문자열 작업이 안정적).
- 토큰 → Shell → 공용 컴포넌트 → 페이지 순. 역순(페이지부터)으로 가면 중복 작업 발생.
- 문자열 외부화는 **페이지 시각 작업과 같은 커밋에 묶지 말고 별도 커밋으로** 분리. 리뷰 시 "디자인 변경" 과 "문자열 이동" 을 섞으면 실질적인 디자인 diff 를 읽기 어렵다.
- 스크린샷을 PR 설명에 before/after 로 ko/en 둘 다 첨부.
- Figma 시안은 **무드보드**. 1:1 복제 금지 — 제품에 맞지 않는 요소(Kanban, 주석 카운트 등)는 가져오지 않는다.

## 열린 질문 (내일 결정)

1. 다크 모드 토글 UI 까지 넣을지, 아니면 토큰만 깔아두고 토글은 후속으로 미룰지.
2. `ReleaseTable` 을 "카드 그리드" 로 바꿀지, "다시 테이블이지만 스타일만" 유지할지 — 릴리스 수가 많아질 때의 스캔성 손실을 감안해 토글 두는 쪽이 타협안.
3. 사이드바 폭(220–260px 구간)·축소 토글 동작 세부.
4. 브랜드 색(accent) 한 가지 결정 — kubeport 로고 용도까지 볼 것.
5. **i18n 라우팅**: 쿠키 기반(단순, 공유 링크에서 로케일 유실) vs. path prefix `/(ko|en)/*` (복잡, URL 에 명시). 내부 툴 성격 고려하면 쿠키 유력.
6. **메시지 키 누락 방지**: 타입 생성(`messages.d.ts`) vs. 런타임 경고 — 타입 쪽이 안전하지만 빌드 파이프라인에 스텝 추가 필요.
7. **영어 번역 1차 소스**: 개발자 본인 + LLM 교정만으로 런칭할지, "영어는 베타" 배너를 둘지.
8. **`KubeTermsToggle` × 로케일**: 현재 "Friendly vs. k8s 원시 용어" 토글이 한국어 전제로 설계됨. 영어 로케일에서도 같은 축이 의미가 있는지 (영어권 개발자는 처음부터 `Deployment` 에 익숙할 수 있음) — 로케일별로 토글 기본값을 달리할지, 영어에서는 토글을 숨길지 결정.
