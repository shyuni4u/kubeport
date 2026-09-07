# kubeport 자율 개선 루프(UX + 마케팅) 리서치 — 2026-09-07

> 상태: **결정 반영 완료 → 스펙으로 승격됨**: [2026-09-07-self-improving-loop-design.md](../superpowers/specs/2026-09-07-self-improving-loop-design.md).
> 2026-09-07 사용자 결정: 리뷰=Routines·구현=Action, 리포 공개, 데모 모드 A안(Dex)·Plan 11 앞, **마케팅은 능동 홍보 없이 기록(릴리스 노트·블로그·데모 영상·지표)만** — 아래 §3·Postiz·Listmonk·소셜 채널 항목은 참고용으로만 남김.
> 조사 방법: Claude Code 서브에이전트 3개 병렬 웹 리서치 (UX 평가 도구 / 자율 루프·가드레일 / 마케팅·OCI 호스팅) + 로컬 리포 인벤토리.

## 0. 현재 상태 인벤토리 (리포 기준)

| 항목 | 상태 |
|---|---|
| MCP | `.mcp.json` 에 Playwright MCP 만 등록 |
| 스킬 | `.claude/skills/role-review` — 코드 기반 역할별 UX 리뷰. **브라우저 조작 없음** ("이 세션에서 불가" 라고 명시) |
| CI | `playwright.yml`(PR·main e2e), `helm.yml`(lint+kind smoke), `build-images.yml`, `uptime-ping.yml` |
| 분석/피드백 | **없음** — frontend 에 posthog/umami/gtag/clarity 전부 미검출 |
| 마케팅 자산 | README(en/ko) 만. 블로그·랜딩·changelog 없음 |
| 선행 리스크 | `kubeport` 네이밍 미통일(CLAUDE.md 잔여 항목 a), Google 로그인 필수(데모 불가), 리포 공개/라이센스 여부 미확정 |

## 1. 종합 제안 — 세 개의 루프, 하나의 메모리

```
[UX 루프 · 주 1회 무인]
  Sentry MCP (에러·에러 세션 리플레이·피드백) ─┐
  Umami MCP (페이지뷰·utm·커스텀 이벤트 퍼널)  ┤
  Playwright MCP 페르소나 워크스루(admin/user) ├→ 발견(휴리스틱+심각도 인용) → docs/ux-backlog.md 갱신
  Chrome DevTools MCP Lighthouse/a11y        ─┘   + GitHub Issue ≤3건 (label: ux-loop)   ※ 코드 변경 없음
                    │
          사람이 label `agent-go` 부착  ← 승인 게이트 #1
                    ▼
[구현 · 이벤트 트리거]  claude-code-action: 이슈 1건 → draft PR
  caps: --max-turns 25 --max-budget-usd 3, timeout 30m, concurrency 1
  PreToolUse hook: kubectl/helm/ssh/prod curl 차단
                    ▼
[검증 · PR]  playwright.yml(required) + toHaveScreenshot 시각 회귀 + helm kind smoke + /code-review 1회
                    ▼
          사람이 merge  ← 승인 게이트 #2
                    ▼
[학습]  PR close 시 결과(merged/rejected+이유, 토큰, e2e delta) → docs/ux-loop-log.md
        다음 주 리뷰어가 로그를 먼저 읽고 거절된 범주 회피

[마케팅 루프 · 주 1회]
  무인:   git log → 릴리스 노트 → docs/blog(Next.js 정적) + Dev.to canonical + Bluesky
          Umami/Sentry + GitHub traffic 스냅샷 → docs/marketing/metrics/YYYY-WW.md
  반자동: Postiz 큐에 LinkedIn/X 초안 → 사람 5분 승인 (Postiz 공식 MCP)
          Reddit/OKKY 관련 스레드 감지 + 답변 초안 → 사람 게시
  수동:   GeekNews Show GN, Disquiet 메이커로그, velog (릴리스 단위) / Show HN, PH, awesome-list (1회성)

[메모리 · 전부 git]
  CLAUDE.md(규칙) · docs/ux-backlog.md(큐) · docs/ux-loop-log.md(결과+지표 JSON)
  GitHub Issues 라벨(ux-loop / agent-go / rejected-by-human) · auto-memory 는 의존하지 않음
```

### 왜 이 구조인가
- **"스스로 발전"의 실체는 메모리 + 측정.** Anthropic 장기 에이전트 하네스 글과 Pydantic/arXiv 사례 모두 "LLM 자기 채점은 게이밍된다, 진짜 학습 신호는 merge 율·회귀 수·지표 추세" 로 수렴. 그래서 결과 로그와 지표 JSON 을 커밋하고, 리뷰어가 매주 그걸 먼저 읽게 한다.
- **프로덕션은 절대 직접 안 건드림.** 에이전트 권한 = 브랜치 push + draft PR. helm/kubectl 은 hook 으로 물리 차단.
- **1 run = 1 PR.** PR 스팸·토큰 폭주(50스텝 루프 $5+/건 보고)의 공통 해법.
- **마케팅은 채널별 자동화 등급을 분리.** 자동 발행 안전: Bluesky·Dev.to·자체 블로그·GitHub Release. 사람 승인: LinkedIn·X. 금지: Reddit(Responsible Builder Policy 2026-06), HN, Kubernetes Slack, GeekNews(약관).

## 2. 도구/MCP 채택표

### 채택 (무료)
| 도구 | 용도 | 설치 |
|---|---|---|
| Playwright MCP (기존) | 페르소나 태스크 워크스루, a11y 트리 스냅샷 | 이미 `.mcp.json` |
| **Chrome DevTools MCP** (Google 공식) | Lighthouse 점수(perf/a11y/SEO), 트레이스, 모바일 에뮬 | `claude mcp add chrome-devtools npx -y chrome-devtools-mcp@latest` |
| **Sentry Developer 플랜 + 공식 MCP** (2026-09-07 사용자 결정: PostHog 는 MCP·SDK 모두 사용 불가) | 에러 5k/월, 에러 세션 리플레이 50/월(`replaysOnErrorSampleRate:1, replaysSessionSampleRate:0`), User Feedback 위젯, uptime 1 + cron 1, 1석, 30일 보존 | `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp`. 광고차단 회피 `tunnel: "/monitoring"`. Seer 만 유료 |
| **Umami** (self-host, k3s) | 마케팅 유입(ref/utm) + **커스텀 이벤트로 제품 퍼널**(카탈로그→폼→릴리스) — PostHog 퍼널 대체, 퍼스트파티, ~512MB | 커뮤니티 MCP `uvx umami-mcp-server`. kubeport PG 공유 |
| **GitHub 공식 MCP** | 이슈/디스커션 트리아지, traffic API(14일 롤링 → 주간 스냅샷 필수) | 읽기 PAT + 쓰기 전 사람 확인(프롬프트 인젭션 사례 있음) |
| **Postiz** (self-host, AGPL, 공식 MCP) | 소셜 스케줄러 30+ 채널, 예약 큐 = 승인 지점 | ~1.5GB(앱+Redis+temporal). `postiz.com/mcp` |
| **Listmonk** (self-host) | 뉴스레터, ~100MB, OCI Email Delivery 3k/월 무료 | 구독자 생기면 |
| Google Search Console (커뮤니티 MCP) | 주간 유입 쿼리 → 문서 보강 | `ncosentino/google-search-console-mcp` |
| UX 스킬 3종 | `EliaAlberti/ux-audit-skill`(스크린샷 휴리스틱, 심각도 0–4), `mastepanoski/claude-skills` 의 `cognitive-walkthrough`·`nielsen-heuristics-audit`, `gotalab/uxaudit` 플러그인(라우트→저니 자동 생성→Playwright 워크스루; 54★ 실험적, 워크트리에서 시험) | skills add / plugin install |
| `@axe-core/playwright` | e2e 에 a11y 게이트 (Plan 11) | dev dep |
| Playwright `toHaveScreenshot` | 시각 회귀, 베이스라인 리포 내 | 기본 내장. 리뷰 UI 필요하면 Argos 무료 5k/월 |
| 스케줄러 | **Claude Code Routines**(구독 쿼터, Pro 5 / Max 15 회/일) 또는 **claude-code-action@v1 cron**. 이벤트(라벨→PR)는 Action | 아래 §4 결정 필요 |

### 스킵 (이유)
Figma MCP(무료 6 calls/월), Deque Axe MCP(유료), Storybook MCP(Storybook 없음), Clarity(에이전트용 10 req/일 한도), AgentUX/Loop11(API 없음), Featurebase(API 유료), Sentry self-host(16GB), Plausible(ClickHouse 2–4GB), n8n(Claude+GHA 가 이미 오케스트레이터, 1–4GB), GrowthBook/A-B(트래픽 부족으로 무의미), Mixpost(MCP $299), Hashnode(API $5/월), Medium(API 사망), Ralph loop(외부 스케줄러로 부적합 — 단일 태스크 전용), Claude Code Review 제품($15–25/PR).

### OCI A1 예산
kubeport ≈1–2GB + Postiz 1.5GB + Umami 0.5GB + Listmonk 0.1GB ≈ **4–5GB / 24GB**. 전부 arm64 이미지. Ingress 는 `*.enzo.kr` + 기존 cert-manager.

## 3. 채널 자동화 등급 (마케팅)

| 등급 | 채널 | 근거 |
|---|---|---|
| 🟢 완전 자동 | Bluesky(AT Proto, MCP 다수), Dev.to(Forem API, canonical), 자체 블로그, GitHub Release | 개방 API, 약관 무리 없음 |
| 🟡 사람 승인 | LinkedIn(60일 토큰 재인증, 100 calls/일), X(2026-02 무료 티어 폐지, 링크 포스트 $0.20/건 → 주 3회 ≈ $2.4/월), YouTube 데모 1편 | 비용/재인증 개입 |
| 🔴 수동만 | Reddit(자동 게시 금지 정책), HN Show HN(1회, **로그인 없는 데모 필수**), Kubernetes Slack(홍보 금지), GeekNews(약관), velog/Disquiet/OKKY(API 없음) | 자동화 = 계정·신뢰 소각 |

## 4. 사용자 결정 필요 항목

1. **스케줄러**: Routines(제로 인프라, 구독 쿼터) vs GHA claude-code-action(리포 옆, 이벤트 트리거 강함). 권장: **리뷰=Routine, 구현=Action**. 현재 플랜(Pro/Max)에 따라 Routines 일일 한도 확인.
2. ~~분석 스택~~ **결정됨(2026-09-07)**: PostHog 사용 불가 → **Sentry Developer(에러·리플레이·피드백·업타임) + Umami self-host(분석·퍼널)**. 히트맵은 포기(대안 Clarity 는 에이전트용 한도 부족, 사람이 볼 용도로만 선택 가능).
3. **리포 공개 + 라이센스**: awesome-list·CNCF Landscape·Dev.to 크로스포스트 전부 OSS 전제. LICENSE 파일은 있으나 공개 여부 확인.
4. **읽기 전용 데모 모드**: Show HN·GeekNews 전환율의 핵심. 백엔드 게스트 role 또는 시드 데이터 read-only 클러스터. Plan 11 앞에 끼울지.
5. **월 예산 상한**: 에이전트 토큰(Max 5x 기준 주 1리뷰+2PR ≈ 10–20 세션/월 상당) + X API 몇 달러. Anthropic "programmatic credit pool" 분리(2026-06 발표 후 보류)가 재개되면 GHA/Routine 사용이 별도 $100–200 캡으로 이동할 수 있음.

## 5. 선행 과제 (루프 켜기 전)

- (a) `kubeport` 네이밍 통일 — 외부 발행 후 링크 깨지면 회수 불가.
- (b) Sentry SDK(에러 샘플링 리플레이 + 피드백 위젯 + tunnel) + Umami 스크립트·퍼널 이벤트 삽입 → **2주 베이스라인 데이터** 확보 없이는 UX 루프가 의견만 낸다.
- (c) `playwright.yml` 을 main 의 required check 로.
- (d) `role-review` 스킬을 Playwright MCP 사용형으로 개정 ("브라우저 불가" 문구 제거, 페르소나별 태스크 목록·측정 항목: 클릭 수·에러 수·완료 여부).
- (e) 데모 모드(§4-4).

## 6. 단계별 도입 순서 (승인 시 스펙으로 승격)

| 주차 | 작업 | 산출물 |
|---|---|---|
| 1 | 선행 (a)(b)(c) + Chrome DevTools MCP + UX 스킬 설치 | 데이터 수집 시작, 네이밍 PR |
| 2 | `role-review` v2(브라우저), `docs/ux-backlog.md`·`ux-loop-log.md` 스캐폴드, 주간 Routine(이슈만) | 첫 무인 리뷰 결과 3건 |
| 3 | `agent-go` 라벨 → claude-code-action 워크플로 + hook 차단 + 캡 + 시각 회귀 | 첫 에이전트 draft PR |
| 4 | 마케팅: changelog→블로그/Dev.to/Bluesky 무인 파이프라인, Umami/GitHub 지표 스냅샷 | 첫 주간 리포트 |
| 5 | Postiz + Umami k3s 배포(Helm values 추가), LinkedIn/X 승인 큐 | 반자동 소셜 |
| 6+ | 데모 모드 → Show GN/Show HN 1회, awesome-list PR, Listmonk | 런치 |

---

## 부록 A. 원문 보고서 — UX 평가 도구

(서브에이전트 1 결과, 원문)

### A.1 에이전트 측 평가 도구

| Tool | What it does | Cost / self-host | How Claude Code consumes it | Verdict |
|---|---|---|---|---|
| **Playwright MCP** (Microsoft) | Drives a browser; `browser_snapshot` returns an accessibility tree (LLM-friendly, no vision needed), plus screenshots, console, network, `browser_fill_form`. | Free, OSS | `claude mcp add playwright npx @playwright/mcp@latest` — already in `.mcp.json`. https://github.com/microsoft/playwright-mcp | **Core.** Use for task-flow walkthroughs of catalog → deploy form → release detail. |
| **Chrome DevTools MCP** (Google, official) | CDP access: `lighthouse_audit` (perf/a11y/SEO/best-practices scores), `performance_start_trace` (LCP/CLS/INP), `emulate` (mobile/throttle), screenshots, console w/ source maps. v0.21+ (Apr 2026), weekly releases. Lighthouse added an "Agentic Browsing" category (May 2026). | Free, Apache-2.0 | `claude mcp add chrome-devtools npx -y chrome-devtools-mcp@latest` (`--slim` for basic). https://github.com/ChromeDevTools/chrome-devtools-mcp | **Add.** Complements Playwright: Playwright for flows, DevTools for Lighthouse/perf numbers. |
| **a11y-mcp** (priyankark) | axe-core audit of a URL: `audit_webpage`, `get_summary`, WCAG tag filter. | Free, MPL-2.0; small community project (17 commits) | `npx a11y-mcp`. https://github.com/priyankark/a11y-mcp | OK as free axe wrapper; alternative is `@axe-core/playwright` in your own e2e tests (Plan 11) — more durable. |
| **Deque Axe MCP Server** (official) | axe + remediation guidance. | **Paid-only** ($79+/mo). https://www.deque.com/axe/mcp-server/ | Skip. | Paid; free alternatives suffice. |
| **Figma MCP** (official, remote) | Read design nodes/variables/code. Starter/View seats = **6 tool calls/month**. https://help.figma.com/hc/en-us/articles/32132100833559 | Free-tier effectively unusable | `claude mcp add --transport http figma https://mcp.figma.com/mcp` | **Low fit.** Figma ref already encoded as tokens in Plan 7. |
| **shadcn MCP** (official) | Browse/search/install registry components. | Free | `pnpm dlx shadcn@latest mcp init --client claude`. https://ui.shadcn.com/docs/mcp | Useful for building, not evaluating. `vercel:shadcn` skill already available. |
| **Storybook MCP** | Component docs/stories/test-run tools. Requires Storybook 10.6, "preview". | Free | `npx storybook add @storybook/addon-mcp` | **Skip** — no Storybook in kubeport. |
| **Anthropic `frontend-design` plugin** | SKILL.md forcing aesthetic commitment; anti-"AI slop". | Free | `/plugin install frontend-design` | Generation aid, not review. |
| **gotalab/uxaudit** (plugin) | Reads routes/code → 5–8 user journeys → walks live app via Playwright → ~40 checks (WCAG 2.2 AA, Nielsen, Krug, Baymard, "AI-slop") → ranked fix plan + screenshots, cross-run comparison. Apache-2.0. https://github.com/gotalab/uxaudit | Free | `claude plugin marketplace add gotalab/uxaudit && claude plugin install uxaudit@gotalab-uxaudit` | **Closest match to autonomous continuous UX eval.** Caveat: 54 stars, 2 commits, experimental. |
| **EliaAlberti/ux-audit-skill** | Screenshot-based heuristic audit across 16 frameworks, Nielsen 0–4 severity, annotated screenshots, S/M/L effort. MIT. https://github.com/EliaAlberti/ux-audit-skill | Free | Copy to `~/.claude/skills/ux-audit/` | **Good complement**: feed Playwright screenshots. |
| **mastepanoski/claude-skills** | `nielsen-heuristics-audit`, `wcag-accessibility-audit`, `don-norman-principles-audit`, `cognitive-walkthrough`, `ui-design-review`, `ux-audit-rethink`. MIT. https://github.com/mastepanoski/claude-skills | Free | `npx skills add mastepanoski/claude-skills --skill nielsen-heuristics-audit` | `cognitive-walkthrough` fits the non-k8s persona. |

### A.2 제품 분석 (MCP 읽기)

| Tool | Data | Free / self-host | Hookup | Verdict |
|---|---|---|---|---|
| **PostHog** | Analytics, funnels, retention, session replay (AI summaries), heatmaps, surveys, flags, error tracking, SQL. Official MCP 50+ tools. https://github.com/PostHog/posthog/tree/master/services/mcp | Cloud free: 1M events, 5k recordings, 1.5k survey responses/mo. Self-host hobby ~4 CPU/16GB, ARM undocumented → not on A1. | `npx @posthog/wizard@latest mcp add` or remote `https://mcp.posthog.com/mcp` | **Best single choice.** |
| **Microsoft Clarity** | Heatmap numbers, rage/dead clicks, recording lists. Official MCP. | Free SaaS | `npx @microsoft/clarity-mcp-server` | **10 API req/day, 3 days data** → too throttled for agent loops. |
| **Umami** | Pageviews, stats, active users. Community MCP. https://github.com/Alurith/umami-mcp-server | MIT, Node+Postgres ~512MB | `uvx umami-mcp-server` | Privacy-friendly pageview layer; no replay/funnels. |
| **Plausible** | Stats API v2. https://github.com/getsentry/plausible-mcp | CE needs ClickHouse 2–4GB; Cloud $9/mo | npx | Heavier than Umami; skip. |
| **Google Analytics MCP** (official, experimental) | run_report, funnel, realtime; read-only. https://github.com/googleanalytics/google-analytics-mcp | Free, GCP project | `pipx run analytics-mcp` | Superseded by PostHog here. |
| **Sentry MCP** | Issues, traces, Seer RCA(paid). | Free 5k errors/mo; self-host ~16GB | `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp` | PostHog error tracking (100k free) may make it redundant. |

### A.3 프레임워크 / 합성 사용자 테스트

Nielsen 10 + severity 0–4 (baseline rubric; agent cites heuristic per finding) · Cognitive walkthrough per task (create/update/delete release, view logs) for the non-k8s persona — **highest value** · Synthetic persona testing (UXAgent, PerceptUI arXiv 2606.05697) doable today with Playwright MCP + persona prompt · AgentUX / Loop11 / Tessary / Brox.ai: no API/MCP → skip.

### A.4 인앱 피드백

PostHog Surveys (1.5k/mo free, same MCP) — **pick** · Formbricks 5.1 (AGPL, MCP + Hub; unclear if MCP is AGPL or enterprise-gated; 1 vCPU/2GB) · Canny (free ≤25 users, community MCP) — overkill · Featurebase (API Pro-only) — skip.

## 부록 B. 원문 보고서 — 자율 루프·메모리·가드레일

(서브에이전트 2 결과, 원문)

### B.1 스케줄링

| Option | What | Cost | Triggers | Verdict |
|---|---|---|---|---|
| **Claude Code Routines** (`/schedule`) | Saved prompt + repo + connectors on Anthropic cloud; output = draft PR / PR comment / Slack | Subscription quota. Daily caps: Pro 5, Max 15, Team 25. Research preview; webhook events beyond hourly caps **dropped** | cron, API endpoint, GitHub webhook (filter by label/draft/branch) | **Best zero-infra start** for nightly/weekly "review + propose". https://code.claude.com/docs/en/routines |
| **claude-code-action@v1** | Claude Code in GHA; `claude_args: --max-turns N --max-budget-usd X` | GHA minutes + API tokens or `CLAUDE_CODE_OAUTH_TOKEN`. Programmatic credit pool split announced 2026-06-15 then **paused** | `schedule`, `issues`, `pull_request`, `workflow_dispatch`, `issue_comment` | **Best for event-driven** (label → PR). Needs explicit `--allowedTools`. https://code.claude.com/docs/en/github-actions |
| `claude -p` k8s CronJob on OCI | Headless CLI in-cluster | same tokens | anything | Only if in-cluster access needed. |
| Claude Agent SDK | Programmatic harness | same | anything | Overkill until loop stabilizes. |
| Ralph Wiggum / `ralph-loop` plugin | Stop hook re-feeds prompt until done | 30–100× cost reports | manual | Single bounded task only; **bad outer scheduler**. |
| GitHub Agentic Workflows (gh-aw) | Markdown agent workflows, "safe-outputs" (propose → separate job applies), `max-ai-credits` | GHA + tokens | cron + events | Copy the safe-outputs pattern. https://github.github.com/gh-aw/ |

### B.2 메모리·학습

Auto-memory: machine-local, invisible to Routines/GHA → weak · CLAUDE.md: the only memory every runtime sees · **Repo docs as memory** (`docs/ux-backlog.md`, `docs/ux-loop-log.md`): Anthropic "progress file" pattern (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents, https://github.com/anthropics/cwc-long-running-agents) · GitHub Issues with agent labels (`ux-loop`, `agent-proposed`, `rejected-by-human`) · Rubric self-grading: generators overrate themselves; separate evaluator, binary pass/fail (arXiv 2607.12790, https://pydantic.dev/articles/when-agents-improve-agents) · Metrics history JSON per run: **the trend is the learning signal**.

### B.3 가드레일

PR-only, branch protection · Preview env: (a) ArgoCD PR generator per-namespace on k3s w/ quotas, (b) kind in GHA extended to run Playwright (start here), (c) Vercel preview — poor fit (BFF/Ingress under test) · e2e required check · Visual regression: Playwright `toHaveScreenshot` first; Argos 5k/mo free; Chromatic 5k/mo; **Lost Pixel discontinued (Apr 2026)** · Human approval: draft PRs, required review · Budget: `--max-turns`, `--max-budget-usd`, `timeout-minutes`, `concurrency`, PreToolUse hooks blocking kubectl/helm/ssh · Bot-loop: `allowed_bots`, don't let agent PR trigger agent.

### B.4 레퍼런스·실패 사례

Anthropic harness posts (initializer + worker + separate evaluator; failures: premature done, editing tests to pass) · Claude Code Review product ~$15–25/PR → use `/code-review` skill instead · Vercel Agent read-only PR review · Sentry Seer / Factory: **trigger on concrete signal** (error, failing e2e), not "improve the app" · Failure modes: runaway tokens (50-step loops $5+), PR spam from open-ended prompts, evaluator gaming, agents editing tests.

Sources: Routines docs/blog · GitHub Actions docs · Agent SDK loop · ralph-loop plugin · gh-aw · Effective harnesses · cwc-long-running-agents · Pydantic · arXiv 2607.12790 · digitalapplied.com credit overhaul 2026-06-15 · leanopstech cost runaway · oneuptime ArgoCD PR previews · argos-ci visual regression 2026 · codeant.ai Claude Code Review pricing · vercel.com/docs/agent · blog.sentry.io self-healing · dev.to jackbcai hooks guardrails.

## 부록 C. 원문 보고서 — 마케팅·OCI 호스팅

(서브에이전트 3 결과, 원문)

### C.1 채널

| 채널 | 2026 현황 | 경로 | 비용 | 판정 |
|---|---|---|---|---|
| X/Twitter | 2026-02 무료 티어 폐지; 게시 $0.015, 링크 포함 $0.20/건, 읽기 $0.005 (postproxy.dev, blotato.com) | Postiz 또는 API | 주 3회 ≈ $2.4/월 | 🟡 한국 k8s 도달 낮음 |
| Bluesky | AT Protocol, 앱 패스워드 | isteamhq/bluesky-mcp, atproto-mcp | 무료 | 🟢 완전 자동 OK |
| LinkedIn | `w_member_social` 개인 게시 가능, 토큰 60일, ~100 calls/일, article/carousel 불가 (zernio, clura) | Postiz | 무료 | 🟡 60일 재인증 |
| Reddit | 셀프서비스 앱 등록 폐지(2025), Responsible Builder Policy(2026-06) 자동 게시 금지; r/kubernetes 90/10 룰 | 읽기만 | 무료 | 🔴 자동 게시 금지 |
| Hacker News | Show HN: 가입 없이 시연 필수, 부스터 댓글 금지 | 없음 | 무료 | 🔴 1회 수동; Google 로그인 필수는 감점 |
| Product Hunt | GraphQL v2, 쓰기 별도 승인 | 읽기 | 무료 | 🟡 ROI 낮음 |
| Dev.to | Forem REST, canonical URL | API | 무료 | 🟢 완전 자동 OK |
| Hashnode | 2026-06 API Pro($5/월) | GraphQL | $5 | 🟡 Dev.to 로 충분 |
| Medium | 게시 API 사망 | — | — | 🔴 |
| GeekNews | API 없음, 약관상 반복 홍보 금지; Show GN 1회 관행 허용 (news.hada.io/terms) | 수동 | 무료 | 🟡 한국 1순위, 수동 |
| velog | 비공식 GraphQL 읽기; 쓰기 회색지대 | 수동 | 무료 | 🟡 |
| Disquiet 메이커로그 | API 없음 | 수동 | 무료 | 🟡 주 1회 |
| OKKY / 커리어리 | API 없음, 홍보 민감 | — | — | 🔴 답변 참여만 |
| YouTube/Shorts | Data API 업로드 가능, 제작 병목 | Playwright 녹화 → 사람 편집 | 무료 | 🟡 60초 데모 1편 |

### C.2 콘텐츠 엔진

GSC: 공식 MCP 없음, 커뮤니티(ncosentino) 🟢 · Ahrefs/Semrush 🔴 · **Changelog 자동화**: GitHub MCP(56 tools) + release-please 또는 Claude 직접 🟢 가장 확실 · Listmonk 🟢 (OCI Email Delivery 3k/월) · Buttondown 100구독자 무료 🟡 · Resend 3k/월 🟡 · GrowthBook 🔴 트래픽 부족.

### C.3 커뮤니티

GitHub stars 지렛대: README 60초 GIF, `good first issue`, awesome-list PR(`awesome-kubernetes`, `awesome-selfhosted`, `awesome-k8s-resources`) · CNCF Landscape: **300★ 이상** 필요 · Kubernetes Slack 홍보 금지 · Discord 는 유저 20명 전엔 GitHub Discussions · Issues 트리아지: GitHub MCP, 프롬프트 인젝션 사례 → 읽기 PAT + 쓰기 전 확인 (docs.stacklok.com) · Launch week 대신 "릴리스 1건 = Show GN + Bluesky/LinkedIn/Dev.to 팬아웃".

### C.4 OCI 자체 호스팅

| 도구 | RSS | API/MCP | 판정 |
|---|---|---|---|
| Postiz (AGPL) | 앱 ~1GB + Redis 128MB + temporal ~500MB, PG 공유 | 공식 MCP + Public API | 🟢 채택 |
| Mixpost | ~500MB | API/MCP Pro $299 | 🔴 |
| Umami | ~300–512MB | REST + 커뮤니티 MCP | 🟢 채택 |
| Plausible | 2–4GB ClickHouse | API | 🔴 |
| Listmonk | ~100MB | REST | 🟢 |
| n8n | 1–4GB | REST | 🔴 중복 |
| Formbricks | 1–2GB | REST | 🟡 유저 50명 전 불필요 |
| GrowthBook | ~1GB + Mongo | REST | 🔴 |

### C.5 측정 루프

`발행 → 유입 → 가입 → 템플릿 생성 → 릴리스 배포`: Postiz(post id) → Umami(utm) → GitHub traffic API(14일 롤링, 주간 스냅샷) → kubeport DB users(Google OIDC 첫 로그인) → templates/releases 수. 백엔드에 admin 전용 `/v1/admin/metrics` 1개 추가 또는 read-only PG 계정.

### C.6 선행 과제

(a) 네이밍 통일 전 외부 발행 금지, (b) Google 로그인 없는 read-only 데모, (c) 리포 공개·라이센스 확정.
