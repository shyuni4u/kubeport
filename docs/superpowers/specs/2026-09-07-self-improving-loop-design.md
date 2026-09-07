# 자율 개선 루프 + 데모 모드 디자인 스펙

- 날짜: 2026-09-07
- 상태: **승인됨 (2026-09-07)** → 승인 시 `writing-plans` 로 Plan 13(데모 모드)·Plan 14(UX 루프)·Plan 15(기록 자동화) 작성
- 근거 조사: [docs/research/2026-09-07-self-improving-loop-research.md](../../research/2026-09-07-self-improving-loop-research.md)
- 관련: [CLAUDE.md](../../../CLAUDE.md) 잔여 항목 (c) 데모 시드, Plan 11 e2e 확장, Plan 12 reconciler

## 1. 목표와 비목표

**목표**
1. Claude 가 **주 1회 무인으로** 라이브 앱의 UX 를 두 페르소나(admin / user) 관점에서 실제 브라우저로 걸어보고, 측정 데이터(Sentry·Umami)와 함께 개선 이슈를 낸다.
2. 사람이 라벨 하나로 승인한 이슈를 Claude 가 **draft PR** 로 구현하고, e2e·시각 회귀 게이트를 통과한 것만 사람이 merge 한다.
3. 결과(merge/reject 이유, 지표 추세)가 **git 안에** 쌓여 다음 리뷰의 입력이 된다 — "스스로 발전"의 실체.
4. Google 계정 없이 **관리자/사용자 데모 계정**으로 실제 배포까지 체험 가능 (HN·GeekNews 전환의 전제이자 UX 루프의 안정적 테스트 대상).
5. 릴리스 노트·블로그·데모 영상·트래픽 지표를 **자동 기록**한다. 능동 홍보(소셜 발행)는 하지 않는다.

**비목표**
- 소셜 채널 자동 발행(X/LinkedIn/Bluesky/Dev.to), 뉴스레터, Postiz/Listmonk 배포 — 2026-09-07 사용자 결정으로 제외.
- A/B 테스트, 히트맵 — 트래픽 규모상 무의미 / 도구 제약.
- 에이전트의 프로덕션 직접 조작(helm/kubectl) — 영구 금지.
- 자동 merge — 없음.

## 2. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 스케줄러 | **리뷰 = Claude Code Routines, 구현 = claude-code-action** | Routines 는 제로 인프라·구독 쿼터, Action 은 이벤트(라벨) 트리거와 CI 인접성 |
| 분석 스택 | **Sentry Developer(무료) + Umami self-host**. PostHog 는 MCP·SDK 모두 사용 불가 | 사용자 제약. Sentry = 에러·에러 세션 리플레이·피드백 위젯·업타임, Umami = 페이지뷰·유입·커스텀 이벤트 퍼널 |
| 리포 | 공개 | OSS 전제 채널·awesome-list 가능 |
| 데모 모드 | **A안: Dex 를 데모 전용 IdP 로 추가**, k3s·백엔드 다중 발급자 | 원칙("앱은 UX 레이어, RBAC 는 k8s") 유지, 다중 IdP 가 제품 기능으로 남음, 로컬·CI dex 재사용 |
| 마케팅 | 기록만: git log → 릴리스 노트 → 자체 블로그, 데모 영상 자동 녹화, 트래픽 지표 → docs/README | 사용자 결정 — 홍보는 사람이 영상 게시로만 |
| 예산 (가정) | Max 구독 쿼터 내 + Action 구현 PR 1건당 `--max-budget-usd 3`, 주 최대 3 PR | 미확정 — 사용자 확인 필요 |
| 순서 | **데모 모드 → Plan 11(e2e) → UX 루프 → 기록 자동화** | 데모 계정이 있어야 e2e·루프가 Google 없이 돈다 |

## 3. 시스템 개요

```
                ┌────────────── 주 1회 (Routine, 일 03:00 KST) ──────────────┐
                │  1. docs/ux-loop-log.md · ux-backlog.md · 닫힌 이슈 읽기        │
                │  2. Sentry MCP: 신규 에러 그룹·에러 세션 리플레이·피드백           │
                │  3. Umami MCP: 퍼널(catalog→deploy→release) 이탈 지점·유입          │
                │  4. Playwright MCP: demo-admin / demo-user 로 태스크 워크스루       │
                │     (클릭 수·에러 수·완료 여부·소요 단계 측정, 스크린샷)              │
                │  5. Chrome DevTools MCP: Lighthouse perf/a11y/SEO                 │
                │  6. 휴리스틱(Nielsen 심각도 0–4 + cognitive walkthrough) 인용       │
                │  → ux-backlog.md 갱신(dedup) + GitHub Issue ≤3건 [label: ux-loop] │
                │  → 코드 변경 없음                                                │
                └───────────────────────────┬─────────────────────────────────┘
                                            ▼
                         사람: 이슈에 label `agent-go`  ← 게이트 #1
                                            ▼
┌── GHA claude-code-action (on: issues.labeled) ─────────────────────────────┐
│  이슈 1건 → 브랜치 → 구현(TDD) → draft PR. caps: --max-turns 25,             │
│  --max-budget-usd 3, timeout-minutes 30, concurrency: ux-loop (1)             │
│  settings.json hooks: PreToolUse deny kubectl|helm|ssh|curl *.enzo.kr        │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            ▼
      PR 게이트(required): playwright.yml + toHaveScreenshot 시각 회귀 + helm kind smoke
      + /code-review 1회(코멘트만)
                                            ▼
                         사람: 리뷰·merge/close(+이유 코멘트)  ← 게이트 #2
                                            ▼
      GHA (on: pull_request.closed, label ux-loop): 결과 → docs/ux-loop-log.md
      {issue, pr, outcome, reason, tokens_usd, e2e_delta, lighthouse_delta}
```

**메모리 위치 (전부 git)**: `CLAUDE.md`(규칙, 짧게) · `docs/ux-backlog.md`(큐) · `docs/ux-loop-log.md`(결과 + 지표 JSON 블록) · GitHub Issues 라벨 `ux-loop` / `agent-go` / `rejected-by-human`. auto-memory 는 사용하지 않는다(머신 종속, Routine/GHA 에 안 보임).

## 4. 컴포넌트 설계

### 4.1 데모 모드 (Plan 13)

**인증 경로**
- k3s: `--kube-apiserver-arg=authentication-config=/etc/rancher/k3s/auth.yaml` 로 전환. `AuthenticationConfiguration` 에 JWT 발급자 2개 — `https://accounts.google.com`(기존, username=email) + `https://dex.kubeport.enzo.kr`(신규, username prefix `dex:`). 기존 `oidc-*` 플래그는 제거(둘은 공존 불가). runbook §5 를 이 절차로 갱신하고 `deploy/oci/bootstrap.sh` 에도 반영. 롤백: 이전 플래그 세트로 되돌리는 스크립트 동봉.
- Dex: `deploy/helm/kubeport/` 에 옵셔널 서브차트/템플릿 `dex.enabled`. `staticPasswords` 2개 — `demo-admin@demo.kubeport`, `demo-user@demo.kubeport`(비밀번호는 values secret). Ingress `dex.<domain>`, cert-manager 재사용. 리소스 요청 50m/64Mi.
- 백엔드 `auth.Verifier` → `MultiVerifier`: 발급자 목록(`KBP_OIDC_ISSUERS`, JSON 배열 `{issuer, client_id}`)을 순회. 토큰의 `iss` 클레임을 먼저 읽어 해당 검증기만 호출. 기존 단일 env 는 하위호환 유지.
- 프론트 `lib/oidc.ts`: provider 2개(`google`, `dex`). `/api/auth/login?provider=dex&hint=demo-admin` → dex 로그인 페이지로 리다이렉트(`login_hint` 로 이메일 프리필). 세션 쿠키에 `provider` 저장. 콜백은 provider 별 config 로 토큰 교환.
- 클러스터 등록: `clusters.oidc_issuer_url` 은 현재 단일 문자열 — 데모 클러스터는 같은 `oci-a1` 이므로 **컬럼 변경 없음**. 백엔드는 클러스터 발급자 체크를 "토큰 iss 가 클러스터가 신뢰하는 발급자 집합에 포함" 으로 완화하되, 집합은 당장 `[cluster.oidc_issuer_url, dex issuer]` 로 코드 상수화(컬럼 추가는 Plan 12 로 이월).

**권한·격리**
- k3s 네임스페이스 `demo`: `ResourceQuota`(cpu 1 / mem 2Gi / pods 10 / services 5, LoadBalancer·Ingress 0), `LimitRange`(컨테이너 기본 100m/128Mi, 상한 500m/512Mi), `NetworkPolicy` 로 다른 네임스페이스 egress 차단.
- RBAC: `Role demo-admin`(demo ns 전체 CRUD) ↔ `dex:demo-admin@...`, `Role demo-user`(get/list/watch + Deployment/Service/ConfigMap/Job/CronJob create·update·delete, Secret 은 create 만) ↔ `dex:demo-user@...`. 기존 runbook §5-3 의 cluster-admin 데모 바인딩은 사용자 본인 이메일만 남기고 제거.
- 앱 내 권한: `KBP_DEV_ADMIN_EMAILS` 에 `demo-admin@demo.kubeport` 추가 → `kubeport-admin` 그룹. demo-user 는 일반 사용자. 데모 팀 `demo` 에 두 계정 소속 (구현 시 변경: 데모 팀은 만들지 않음 — demo-admin 은 팀 관리가 차단되고 데모 흐름에 기여가 없어 템플릿은 글로벌로 생성).
- 데모 계정은 `POST /v1/clusters`·팀 관리·`?force=true` 삭제 **금지**: 미들웨어에서 `claims.Email` 도메인이 `@demo.kubeport` 이면 해당 경로 403 (사용자 문구 "데모 계정에서는 사용할 수 없습니다"). 이 한 곳이 데모 특수 처리의 유일한 코드 분기.

**시드 데이터** (`backend/cmd/seed-demo/`, 멱등)
- 템플릿 3개, 각 published 버전 1 + draft 1:
  1. `web-app` — Deployment + Service. ui-spec: 이미지 태그(enum), 레플리카(1–3), 환영 문구(ConfigMap env).
  2. `nightly-job` — CronJob. ui-spec: 스케줄(preset enum), 명령 인자.
  3. `app-with-config` — Deployment + ConfigMap + Secret. ui-spec: 설정 키 3개, 비밀값 1개(Secret 타입 필드 UX 확인용).
- 릴리스 2개(demo-user 소유): `web-app` 정상 러닝 1개, `nightly-job` 에 존재하지 않는 이미지 태그로 **실패 상태** 1개(에러 문구·로그 탭 UX 노출용).
- 시드는 admin 토큰이 아닌 **dex demo-admin 토큰으로 API 를 호출**해 생성 → 실제 RBAC 경로 검증 겸용.

**리셋**
- k8s `CronJob demo-reset`(6시간마다, `demo` ns 리소스 전부 삭제 → DB 에서 데모 계정(`*@demo.kubeport`) 소유 템플릿·릴리스·세션 삭제 → seed-demo 재실행). 이미지는 backend 이미지 재사용(`seed-demo` 서브커맨드).
- 릴리스 이름 충돌 방지: 데모 폼의 기본 릴리스명에 4자리 랜덤 접미사.
- 세션: 데모 세션 쿠키 만료 60분, 리셋 시 무효화.

**UI**
- `app/page.tsx` 랜딩 재작성: 한 줄 설명 + 버튼 3개 — **관리자로 체험** / **사용자로 체험** / Google 로 로그인. 데모 버튼 아래 "실제 클러스터에 배포됩니다 · 6시간마다 초기화 · 데이터를 남기지 마세요".
- 데모 세션 중 상단 배너(닫기 가능, 세션 내 1회): 남은 리셋 시간 + Sentry 피드백 위젯 열기 버튼 (Plan 14 로 이월 — Sentry SDK 가 그때 도입됨).
- i18n ko/en.

**테스트**
- 백엔드: `MultiVerifier` 단위(iss 라우팅, 미지원 iss 거부), 데모 403 미들웨어, seed 멱등성.
- e2e(Plan 11 과 공유): dex 로 demo-user 로그인 → 카탈로그 → 배포 → 릴리스 상세 → 로그. demo-admin → 템플릿 새 버전 저장. 로컬 compose 의 dex 는 이미 staticPasswords 라 CI 변경 최소.
- 인프라: kind smoke 에 dex 옵션 렌더 포함(`helm template` golden).

### 4.2 UX 루프 (Plan 14)

**계측 (선행)**
- Sentry: `@sentry/nextjs` + Go SDK. `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 1.0`, `tunnel: "/monitoring"`, User Feedback 위젯(데모 배너·릴리스 실패 배너에서 노출). 릴리스 태그 = 이미지 태그.
- Umami: k3s 배포(Helm values `umami.enabled`, 기존 PG 에 DB 추가, ~512Mi). 스크립트는 `app/layout.tsx`. 커스텀 이벤트 5개: `catalog_view`, `deploy_form_open`, `deploy_submit`, `release_created`, `release_failed_seen`. `data-tag` 로 페르소나(demo-admin/demo-user/real) 구분.
- 2주 베이스라인 후 루프 가동.

**`role-review` 스킬 v2** (`.claude/skills/role-review/SKILL.md` 개정)
- "브라우저 불가" 문구 제거. Playwright MCP 로 dex 데모 계정 로그인 → 페르소나별 태스크 목록 수행:
  - user: 카탈로그에서 web-app 찾기 → 배포 → 상태 확인 → 로그 보기 → 실패 릴리스 원인 이해 → 삭제.
  - admin: 새 템플릿 생성 → 필드 노출 설정 → 폼 프리뷰 → 버전 발행 → 사용자 폼으로 확인.
- 태스크마다 기록: 단계 수, 잘못 클릭 수, 콘솔 에러 수, 완료 여부, 막힌 지점 스크린샷.
- 발견 형식: `[페르소나][화면][Nielsen #n][심각도 0–4] 문제 → 근거(측정/리플레이/스크린샷) → 제안(file:line)`. 기존 인라인 diff 제안 형식 유지.
- 입력으로 `docs/ux-loop-log.md` 의 `rejected` 항목을 먼저 읽고 같은 범주 재제안 금지.

**Routine** (`kubeport-weekly-ux-review`)
- 프롬프트: `/role-review` 실행 → 백로그 갱신 → 이슈 ≤3건 생성(템플릿: 제목 `[ux-loop] ...`, 본문에 근거·측정·제안·예상 규모 S/M/L). 코드 변경 금지 명시.
- 커넥터: GitHub, Sentry MCP, Umami MCP, Playwright MCP, Chrome DevTools MCP. 데모 비밀번호는 Routine 시크릿.
- 실패·차단 시(데모 로그인 불가, MCP 권한 오류, 커넥터 만료 등): 리뷰 이슈 대신 **GitHub Issue `[ux-loop-blocked] <원인>`** 을 열고(같은 원인 이슈가 열려 있으면 코멘트 추가), `docs/ux-loop-log.md` 에 `skipped` 기록. Routine 실행 로그는 사람이 잘 안 보므로 모든 차단은 GitHub 이슈로 표면화한다.

**Action** (`.github/workflows/ux-loop-implement.yml`)
- `on: issues: [labeled]`, `if: label == 'agent-go' && contains(labels, 'ux-loop')`.
- `anthropics/claude-code-action@v1`, `claude_args: --max-turns 25 --max-budget-usd 3 --allowedTools "Edit,Write,Read,Grep,Glob,Bash(pnpm *),Bash(go *),Bash(git *)"`, `timeout-minutes: 30`, `concurrency: {group: ux-loop, cancel-in-progress: false}`.
- 리포 `.claude/settings.json` hooks: PreToolUse 에서 `kubectl|helm|ssh|curl .*enzo\.kr` 매칭 시 exit 2. Routine·로컬에도 동일 적용.
- PR 은 draft, 라벨 `ux-loop` 상속, 본문에 이슈 링크 + 검증 방법. 구현 중 차단(권한·시크릿·캡 초과)되면 그 시점까지의 draft PR 을 남기고 PR/이슈에 `blocked: <원인>` 코멘트 + 라벨 `ux-loop-blocked`. 봇 트리거 방지: `allowed_bots` 미설정(기본 거부).
- 주간 캡: 워크플로 시작 시 지난 7일 `ux-loop` PR 수 ≥3 이면 코멘트 남기고 종료.

**PR 게이트**
- `playwright.yml` required + `@axe-core/playwright` 치명 위반 0 + `toHaveScreenshot`(카탈로그·배포 폼·릴리스 상세·에디터 4장, 베이스라인 리포 내, `maxDiffPixelRatio 0.01`).
- helm kind smoke 유지. `/code-review` 는 Action 이 PR 당 1회만.

**결과 로그** (`.github/workflows/ux-loop-record.yml`, `on: pull_request: [closed]`)
- 스크립트(Claude 불필요)가 `docs/ux-loop-log.md` 에 append:
  ```json
  {"week":"2026-W40","issue":123,"pr":130,"outcome":"merged|rejected","reason":"<closing comment 첫 줄>","tokens_usd":2.1,"e2e_pass":41,"a11y_critical":0,"lighthouse":{"perf":92,"a11y":98}}
  ```
- 리뷰 Routine 은 최근 8주 요약(merge 율, 회귀 수, Lighthouse 추세) 3줄을 이슈 본문 상단에 넣는다 — 학습 신호를 사람에게도 노출.

### 4.3 기록 자동화 (Plan 15)

능동 홍보 없음. 모두 GHA cron 또는 릴리스 트리거, Claude 는 요약 문장 생성에만 사용(선택).

| 항목 | 트리거 | 동작 | 산출물 |
|---|---|---|---|
| 릴리스 노트 | `push tag v*` | Conventional Commits 기반 그룹화(release-please 또는 스크립트) → GitHub Release 본문 | GitHub Release |
| 블로그 | 릴리스 노트 생성 후 | Claude 가 릴리스 노트 → 한국어/영어 짧은 글(무엇이 왜 바뀌었나, 스크린샷 1장) → `docs/blog/YYYY-MM-DD-<slug>.md` | `/blog` 정적 라우트(Next.js, 비로그인 공개, MDX) |
| 데모 영상 | 릴리스마다 | Playwright `recordVideo` 로 user 시나리오(카탈로그→배포→상태) 60초 녹화 → mp4 + GIF(ffmpeg) → `docs/media/demo-<ver>.gif`; README 상단 GIF 링크 갱신 | 사람이 YouTube/게시글 업로드에 사용 |
| 트래픽 지표 | 주 1회 월요일 | Umami API(페이지뷰·방문·유입 top5·퍼널 5단계) + GitHub traffic API(views/clones/referrers — 14일 롤링이라 주간 스냅샷 필수) + stars → `docs/metrics/YYYY-WW.md` + `docs/metrics/latest.json` | README 하단 "📈 지난 주" 섹션 자동 갱신(마커 사이 치환) |

## 5. 데이터 흐름 요약

- 사용자/데모 → Next.js(BFF) → Go → k3s: 변경 없음. 토큰 발급자만 2개.
- Sentry/Umami → Claude(Routine, MCP 읽기 전용) → GitHub Issues/docs: 쓰기는 이슈·백로그 파일만.
- 이슈 라벨 → Action → PR: 쓰기는 브랜치만. main 은 branch protection + required checks.
- PR close → 로그 파일: 스크립트가 커밋(`docs:` 접두어, CI 스킵 태그).

## 6. 에러 처리·안전장치

| 위험 | 대응 |
|---|---|
| 에이전트가 프로덕션 조작 | hooks 로 kubectl/helm/ssh/prod curl 차단(모델 외부 실행) + Action 토큰에 k8s 자격 없음 |
| PR 스팸·비용 폭주 | 1 run = 1 PR, 주 3 PR 캡, `--max-budget-usd 3`, `--max-turns 25`, 30분 타임아웃, concurrency 1 |
| 봇 루프(에이전트 PR 이 에이전트 트리거) | `allowed_bots` 기본 거부, 라벨은 사람만 부착 |
| 이슈 본문 프롬프트 인젭션 | Action 은 `agent-go` 라벨(사람 부착)된 이슈만 읽음; hooks 는 여전히 차단 |
| 데모 리소스 남용 | ResourceQuota/LimitRange/NetworkPolicy, Ingress·LB 금지, 6시간 리셋, 세션 60분 |
| 데모 계정으로 클러스터 등록·팀·강제삭제 | 미들웨어 403 |
| k3s 인증 설정 전환 실패 | 롤백 스크립트 + runbook 절차, 전환 전 `kubectl --token` 으로 두 발급자 사전 검증 |
| Routines 프리뷰 한도(Pro 5/Max 15 회/일) 초과·이벤트 드롭 | 주 1회만 사용, 실패 시 `skipped` 기록 |
| 평가자 자기채점 왜곡 | 자기 점수 대신 merge 율·회귀 수·Lighthouse 추세만 기록 |
| Anthropic programmatic credit pool 분리 재개 | 월 사용량 `ux-loop-log` 로 추적, 캡 초과 시 Routine 비활성 |

## 7. 테스트 전략

- 단위: MultiVerifier, 데모 403, seed 멱등, 지표 스크립트(README 마커 치환), 로그 append 스키마.
- 통합(compose dex): 두 발급자 토큰 각각으로 API 호출.
- e2e(Plan 11 확장): 데모 계정 시나리오 2종 + 시각 회귀 4장 + axe.
- 인프라: helm golden(dex/umami 옵션), kind smoke, k3s 전환 dry-run 스크립트.
- 루프 자체: 첫 4주는 Routine 결과 이슈를 사람이 전부 검토해 false positive 율 기록; 30% 초과 시 스킬 프롬프트 수정.

## 8. 도입 순서와 플랜 분할

| Plan | 범위 | 선행 | 공수(추정) |
|---|---|---|---|
| **13 데모 모드** | 4.1 전체 + runbook/bootstrap 갱신 + 네이밍 통일(a) 병행 | — | 4일 |
| **11 e2e 확장**(기존) | 데모 계정 시나리오, axe, 시각 회귀, required check | 13 | 2일 |
| **14 UX 루프** | 계측(Sentry/Umami) → 2주 베이스라인 → 스킬 v2 → Routine → Action → 게이트 → 로그 | 13, 11 | 3일 + 2주 대기 |
| **15 기록 자동화** | 릴리스 노트·블로그·영상·지표 | 13(영상은 데모 계정 사용) | 2일 |

## 9. 열린 항목

- 월 예산 상한 확정(§2 가정).
- Dex 데모 비밀번호 노출 방식: 랜딩 버튼이 `login_hint` 만 넘기고 비밀번호는 사용자가 입력(화면에 표기) vs dex `mockCallback` 류 자동 로그인. 초안은 **표기+입력**(정직하고 봇 남용 완화) — **구현됨**: 표기+입력 (`DEMO_PASSWORD_HINT` 로 랜딩에 표기, Dex 폼에 `login_hint` 프리필).
- `/blog` 를 Next.js 라우트로 둘지 GitHub Pages 로 분리할지 — 초안은 Next.js(단일 배포).
