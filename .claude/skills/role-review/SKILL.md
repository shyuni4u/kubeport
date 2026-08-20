---
name: role-review
description: >
  Review kubeport's live UX/flows from two role perspectives — Admin (k8s-savvy
  template author) and User (non-k8s template consumer) — and produce concrete
  inline fix suggestions (file:line + before→after diff). Use when the user asks
  to review the app UX by role, "역할별 리뷰", "admin/user 관점 리뷰", to sanity-check
  a screen before a demo, or after changing catalog/deploy/editor/release screens.
---

# role-review — 역할별 UX 리뷰

kubeport 은 **두 역할**을 위한 셀프서비스 포털이다. 이 스킬은 각 역할의 **실제
포지션에서** 라이브 UX/플로우를 리뷰하고, 발견만이 아니라 **파일별 인라인 수정
제안(diff)** 까지 낸다.

> 리뷰는 프론트엔드 코드 + 디자인 스펙 기반으로 각 역할의 플로우를 "걸어보며" 수행한다
> (브라우저 자동 조작은 이 세션에서 불가 — 라이브 URL 은 사람이 교차 확인용으로만 참고).
> 라이브: https://kubeport.enzo.kr

## 두 페르소나 (근거: CLAUDE.md §용어, 디자인 스펙)

**Admin — 템플릿 작성자, k8s 숙련.**
- 목표: pure k8s YAML + ui-spec 오버레이를 빠르고 안전하게 작성/버전관리하고, 어떤
  경로를 사용자에게 어떻게 노출할지 통제한다. RBAC/클러스터를 이해하고 다룬다.
- 통증: 스키마-폼 매핑이 안 보임, 버전 pin/draft 흐름 혼동, 파괴적 액션 실수, k8s 용어가
  숨겨져 오히려 불편, RBAC 판정 결과 불투명.

**User — 템플릿 소비자, k8s 지식 없을 수 있음.**
- 목표: 카탈로그에서 원하는 걸 찾아 **폼만 채워** 배포하고, 배포한 것의 상태/로그를
  k8s 용어 없이 이해한다.
- 통증: 무엇을 배포하는지 모호, 폼 필드 의미/검증 불친절, 에러가 raw(영문 스택/원문),
  이중 제출, 릴리스가 왜 실패했는지 알 수 없음, 빈 상태에서 다음 행동을 모름.

## 화면 소유 맵 (리뷰 앵커 — 실제 경로)

**Admin 소유**
- 템플릿 목록/상세: `app/templates/page.tsx`, `app/templates/[name]/page.tsx`
- 새 템플릿 / 버전 편집: `app/templates/new/page.tsx`, `app/templates/[name]/versions/[v]/edit/page.tsx`
- 에디터 구성요소: `components/MonacoPanel.tsx`, `components/SchemaTree.tsx`,
  `components/FieldInspector.tsx`, `components/KindPicker.tsx`, `components/ResourcesPreview.tsx`
- RBAC / 클러스터: `components/RBACCheckPanel.tsx`, `components/ClusterPicker.tsx`
- 팀: `app/admin/teams/page.tsx`, `app/admin/teams/[id]/page.tsx`
- 파괴적 액션: `components/ForceDeleteButton.tsx`

**User 소유**
- 카탈로그: `app/catalog/page.tsx`, `components/CatalogBrowser.tsx`, `components/CatalogCard.tsx`
- 배포 폼: `app/catalog/[name]/deploy/page.tsx`,
  `app/catalog/[name]/versions/[v]/deploy/page.tsx`, `components/DynamicForm.tsx`
- 릴리스: `app/releases/page.tsx`, `app/releases/[id]/page.tsx`,
  `app/releases/[id]/logs/page.tsx`, `components/ReleaseTable.tsx`,
  `components/ReleaseTabs.tsx`, `components/ReleaseHeader.tsx`,
  `components/LogsPanel.tsx`, `components/InstancesTable.tsx`,
  `components/MetricCards.tsx`, `components/ReleaseStaleBanner.tsx`

**공통 (양쪽 페르소나가 각자 관점으로)**
- 셸/내비: `components/AppShell.tsx`, `components/Sidebar*.tsx`, `components/RoleBadge.tsx`,
  `components/KubeTermsToggle.tsx`, `components/LocaleSwitch.tsx`
- i18n: `messages/ko.json`, `messages/en.json` (모든 사용자향 문자열은 여기 있어야 함)
- 인증 플로우: `app/api/auth/*`, `app/page.tsx`

## 리뷰 루브릭 (역할별 가중치)

각 발견은 반드시 **실제 file:line 에 근거**하고, 아래 차원 중 하나에 매핑한다.

| 차원 | Admin 가중 | User 가중 | 본다 |
|---|---|---|---|
| 명료성/용어 | k8s 용어 노출이 **충분**한가 | k8s 용어가 **평이한 말**로 가려졌나 (`KubeTermsToggle`) | 레이블/설명/툴팁 |
| 안전성 | 파괴적 액션 confirm, draft/버전 pin 명확 | 이중 제출 방지, 되돌리기 안내 | confirm/disabled/pending |
| 발견성/흐름 | 스키마↔폼 매핑, 다음 액션 | 카탈로그 검색/필터, 빈 상태 CTA | empty/loading/next-step |
| 에러 처리 | RBAC 거부 사유 표면화 | **raw 에러 금지** → 사용자 문장 | 4xx/5xx/네트워크/검증 |
| i18n | ko/en 양쪽 존재 | ko/en 양쪽 + 자연스러움 | 하드코딩 문자열 적발 |
| 접근성 | 폼 라벨/포커스 | 라벨/대비/키보드 | a11y 기본 |

## 프로세스

1. **스코프 결정.** 인자로 특정 화면/플로우(예: `deploy-form`, `editor`, `catalog`,
   `release`)가 오면 그 앵커만. 없으면 전체.
2. **두 리뷰어를 병렬로 띄운다** (Task 서브에이전트 2개 — admin-reviewer, user-reviewer).
   각 리뷰어에게:
   - 위 페르소나 정의 + 통증 + 루브릭 + **자기 소유 화면 파일 목록**을 준다.
   - 자기 역할로 각 플로우를 코드에서 걸어보게 한다 (진입 → 조작 → 결과/에러 → 빈/로딩 상태).
   - 발견을 **인라인 수정 제안**으로 반환하게 한다: `{ file, line/anchor, severity(P0|P1|P2),
     dimension, why(역할 관점 한 줄), before, after(구체 코드/문구) }`.
   - i18n 문자열 제안은 `messages/ko.json` + `messages/en.json` **양쪽** diff 를 포함.
   - 근거 없는(파일 미확인) 추측 금지. 각 제안은 실제 코드 조각을 인용.
3. **통합.** 두 결과를 합쳐 중복 제거, severity 정렬(P0→P2), `역할 / 공통`으로 그룹화.
   상충하는 제안(admin 은 용어 노출 원함 vs user 는 숨김)은 `KubeTermsToggle`/역할 분기로
   화해시켜 제시.
4. **결과물 = 인라인 수정 제안.** 각 항목을 **바로 적용 가능한 diff** 로 출력:
   - `파일:line` 헤더 + before→after (또는 통합 diff 블록)
   - 한 줄 근거(어느 역할이 왜)
   - severity 태그
   자동 적용하지 말 것 — 목록을 보여주고 **어느 것을 적용할지 물은 뒤** 적용한다
   (사용자가 "다 적용"/"P0만" 등으로 고르면 그때 Edit).

## 출력 형식 (예)

```
## 🔴 P0 — User · 배포 폼 raw 에러 노출
components/DynamicForm.tsx:142
왜(User): 배포 실패 시 백엔드 원문(영문 JSON)이 그대로 떠서 비전문 사용자가 이해 못 함.
- before:
    setError(String(err))
+ after:
    setError(t("deploy.submitFailed"))   // + messages/{ko,en}.json 에 키 추가
messages/ko.json: "deploy.submitFailed": "배포에 실패했어요. 잠시 후 다시 시도해 주세요."
messages/en.json: "deploy.submitFailed": "Deployment failed. Please try again."
```

## 가드레일
- 모든 발견은 **실존 file:line** 근거. 없는 화면/컴포넌트 발명 금지.
- 사용자향 문자열 제안은 **ko/en 양쪽** 포함 (한쪽만 고치면 반쪽 버그).
- 빈 상태·로딩·에러·이중 제출·권한 거부 경로를 반드시 한 번씩 점검.
- Admin 에겐 k8s 용어를 **감추지 말고**, User 에겐 **노출하지 말 것** — 충돌 시 역할 분기/토글.
- 스코프를 좁혔으면(top-N/특정 화면) 무엇을 안 봤는지 명시.
