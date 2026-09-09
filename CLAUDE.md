# kubeport

k8s 리소스(YAML)를 템플릿화해서, 관리자는 편집하고 비전문 사용자는 폼으로 쓰는 웹 앱.
Swagger가 OpenAPI spec을 UI로 바꿔 주는 것처럼, k8s 리소스를 **추상화된 셀프서비스 포털**로 바꾸는 것이 목표.

## 현재 단계

**🟢 라이브 배포 완료 — https://kubeport.enzo.kr** (OCI Always Free A1, Phase 2 직행). Plan 0~10 실행 완료: 프론트 재설계(0~7) + drift 회수(8) + Helm chart(9) + **OCI 부트스트랩·helm install·Google OIDC·실제 k8s 배포 인프라(10)**. 운영 지식은 반드시 [docs/oci-prod-runbook.md](docs/oci-prod-runbook.md) 참조.

> **▶ 현재 상태 (2026-09-08)** — 데모 가능 상태. 완료 삭제하며 갱신할 것.
> - **실제 k8s 배포까지 동작**: k3s 가 Google OIDC 신뢰 + RBAC 바인딩 + 클러스터 `oci-a1` 등록 (runbook §5). backend 가 사용자 Google 토큰을 k8s API 로 포워딩.
> - **로그인/로그아웃 정상**, admin 부트스트랩(`auth.devAdminEmails`). **운영 하드닝**: idle-reclaim ping(GHA 10분) + 주간 백업 정책.
> - **데모 모드(Plan 13) 라이브** (Helm rev 4, 이미지 `sha-6bf1667`) — `/` 에서 관리자/사용자 체험 버튼(Dex 로그인, 비밀번호 화면 표기), `demo` 네임스페이스 격리, 6시간 리셋, k3s 가 Google+Dex 구조화 인증. 운영: runbook §5. 남은 사람 작업(브라우저 스모크): [docs/plan13-handoff.md](docs/plan13-handoff.md).
> - **2026-09-08 머지분 (PR #3·#4·#5·#7·#9·#10·#15)** —
>   - **랜딩 비교 쇼케이스** (#3): `/` 에 "관리자 YAML(약 110줄) vs 사용자 폼(4칸)" 인터랙티브 비교, 값 바꾸면 바뀐 줄 하이라이트(`lib/apply-values-to-yaml.ts`). 데모 시드 `web-app` 을 현실적 크기로 확장(`frontend/lib/showcase/` 복사본은 백엔드 원본과 바이트 일치 테스트). 같이 잡은 버그: `DynamicForm` 이 `[...]` 포함 경로에서 사용자 입력을 버리고 기본값 제출(RHF 가 `[`·`]` 도 경로 구분자로 해석).
>   - **role-review v2** (#5): 관리자/사용자 페르소나 리뷰 20건 전부 반영 — 전역 `error.tsx`/`not-found.tsx`, 서버 액션 인라인 에러(`ActionForm`), zod 검증 메시지 i18n, 에디터 미저장 가드(뒤로가기는 App Router 한계), 사용자 릴리스 삭제, RBAC 미매핑 kind 경고, 저작 UI 문자열 전부 i18n(ko/en parity 285/285), `(?)` 도움말(`HelpHint`)과 인스펙터 도움말 입력칸. **원칙: 어려운 용어엔 `(?)`, 사용자 편의 최우선.**
>   - **BFF 프록시 PATCH 누락** (#7) — UI 모드 draft 저장·메타 수정이 405 였던 초기 버그.
>   - **Plan 11 e2e 1차** (#10): `05-user-deploy`·`06-admin-draft-save`·`07-error-pages` + 기존 `02/03` 한국어 라벨·confirm 수락 수정 + CI rolebinding 재시도. **e2e 는 로컬에서 먼저** — `scripts/e2e/*` (#15, [docs/local-e2e.md §0](docs/local-e2e.md)), 이 머신 13/13 28초.
>   - `kuberport` 잔존은 실제 파일명이라 유지, 스크립트만 새 이름 우선 (#9). `bootstrap.sh` CIDR/OIDC 반영은 #1 로 완료.
> - **PR 리뷰어 시스템 (2026-09-08)** — `/pr-review` 스킬 + `.claude/agents/*-reviewer.md` 7개 + `gh pr create` 훅(`.claude/hooks/require-pr-review.mjs`, node 테스트 6개). 리포에 커밋되어 모든 PC 공통. 브라우저 대상은 라이브 데모(`--base-url` 로 staging 교체 예정). 첫 dry-run 이 자기 PR 의 P0(커밋된 settings.json 의 프로덕션 SSH 허용 규칙)·P1(helm template 검증 명령 오류)을 잡아 수정함.
> - **남은 것**: (a) **[issue #20](https://github.com/shyuni4u/kubeport/issues/20)** 다른 PC 에서 `scripts/e2e/up.sh` 생성 경로(인증서·kind) 첫 검증, (b) Plan 11 후속 — 라이브 OCI smoke(프로덕션에 릴리스 생성/삭제 여부 결정 필요)·클러스터 끊김/drift 케이스, (c) 프론트 eslint 기존 오류 6건(`set-state-in-effect`), (d) 라이브 데모에서 관리자/사용자 체험 한 바퀴.
> - **주의**: 공인 IP `168.107.55.95` 는 ephemeral(stop/start 시 변경), SSH 키는 gpg 번들→`~/.ssh/kuberport-oci/` (`kuberport` 표기는 아래 "확정된 결정" 표 참조 — 고치지 말 것). 재배포·RBAC·롤백은 runbook.

스펙: [docs/superpowers/specs/2026-04-19-frontend-design-spec.md](docs/superpowers/specs/2026-04-19-frontend-design-spec.md) (4 화면: Admin UI 에디터 / 카탈로그 / 배포 폼 / 릴리스 상세)

플랜 (순서대로 실행 — Plan 0 은 1-4 의 공통 기반):

| # | 플랜 | 상태 | 범위 |
|---|---|---|---|
| 0 | [frontend-foundation](docs/superpowers/plans/2026-04-19-frontend-foundation.md) | ✅ merged (PR #16) | 패키지·shadcn·Vitest·RoleBadge·StatusChip·TopBar 재편·Providers·Zustand·MonacoPanel |
| 1 | [catalog-redesign](docs/superpowers/plans/2026-04-19-catalog-redesign.md) | ✅ merged (PR #17) | `/catalog` + CatalogCard + 검색/태그 필터 + 아이콘 맵 |
| 2 | [release-detail-redesign](docs/superpowers/plans/2026-04-19-release-detail-redesign.md) | ✅ merged (PR #18) | 중첩 라우트 + 개요·로그 탭 + **SSE 백엔드 추가** + k8s 용어 토글. UpdateAvailableBadge 는 Plan 3 으로 이월 (`current_version` 정수 필드·`?updateReleaseId=` 라우트 의존). |
| 3 | [deploy-form-redesign](docs/superpowers/plans/2026-04-19-deploy-form-redesign.md) | ✅ merged (PR #19) | **백엔드 3개 엔드포인트** (render/PUT releases/SSAR) + shadcn DynamicForm + RBAC 패널 + 업데이트 플로우 |
| 4 | [admin-editor-redesign](docs/superpowers/plans/2026-04-19-admin-editor-redesign.md) | ✅ merged (PR #20) | ResizablePanelGroup + MetaRow + BottomBar + SchemaTree 배지 + FieldInspector enum values + ?mode=ui\|yaml 분기 |
| 5 | [backend-meta-normalization](docs/superpowers/plans/2026-04-19-backend-meta-normalization.md) | ✅ merged (PR #21) | **MVP 전 필수 정리** — `/v1/templates/:name` JOIN 확장, `values_json` RawMessage, `PATCH /v1/templates/:name` 신설, 배포 폼 클러스터 드롭다운. Plan 3·4 구현 중 발견된 백엔드 구멍들. |
| 6 | [post-mvp-stabilization](docs/superpowers/plans/2026-04-22-post-mvp-stabilization.md) | ✅ merged (PR #27) | 첫 실제 브라우저 테스트에서 발견된 버그·UX 갭 정리 — 레거시 `/templates/[name]/edit` 제거, 상세 페이지 permission-aware UI + `+ 새 버전`·`삭제`, `/templates/new` + version-edit 모드 탭, yaml→UI 변환 + 사용자 폼 preview, 릴리스 리스트 `상태` 컬럼 제거. **백엔드 추가**: `PATCH`/`DELETE /v1/templates/:name/versions/:v` (drafts-only), core-API openapi 경로 수정, `ui_state_json` RawMessage, `TestMain` cleanup. |
| 7 | [plan7-visual-refresh](docs/superpowers/plans/2026-04-22-plan7-visual-refresh.md) | ✅ merged (PR #28) | **비주얼 리프레시 + i18n(ko/en) — 기능·라우트·백엔드 변경 없음.** Figma 레퍼런스(`nDP3cHNKf5Cjo6F2HU1EVv`) 기반 디자인 토큰 재정의 + `AppShell`(좌측 사이드바 + 얇은 탑바) 도입 + `CatalogCard`/`ReleaseTable`/`RoleBadge`/`StatusChip`/`MetricCards` 비주얼 리프레시 + `next-intl` 로 사용자향 문자열 외부화 + 로케일 토글 UI. |
| 8 | [plan8-release-stale-cleanup](docs/superpowers/plans/2026-04-28-plan8-release-stale-cleanup.md) | ✅ merged (PR #35) | **DB ↔ k8s drift 회수 (Stage 1).** `GetRelease` 가 `cluster-unreachable` / `resources-missing` 분리 (read-time, DB write 없음). `DELETE /v1/releases/:id?force=true` (admin 전용) 로 k8s 호출 건너뛰고 DB row 만 정리. 릴리스 상세에 explainer 배너 — 일반 사용자에겐 "관리자에게 문의", admin 에겐 강제 삭제 버튼. ko/en i18n. **Stage 2 (reconcile loop, SA 토큰, DB 컬럼) 는 Plan 12 (deferred) 로 분리.** |
| 9 | [plan9-helm-chart](docs/superpowers/plans/2026-04-29-plan9-helm-chart.md) | ✅ 라이브 사용 중 | **Helm chart MVP — Plan 10 의 하드 블로커.** `deploy/helm/kubeport/` 단일 chart 에 backend / frontend / 옵셔널 in-cluster Postgres / Ingress / cert-manager Certificate / atlas migration Job 구성. 클라우드 중립 (Ingress class · StorageClass · 도메인만 values 분기). CI: `helm lint` + golden snapshot + kind smoke. 코드 변경 없음 (chart 만 추가). 추정 공수 2.5–3 영업일. |
| 10 | [plan10-oci-phase2-bootstrap](docs/superpowers/plans/2026-06-24-plan10-oci-phase2-bootstrap.md) | ✅ 실행 완료 (2026-08-20) | **OCI Phase 2 직행 부트스트랩 — 라이브 `kubeport.enzo.kr`.** OCI A1(춘천) + 도메인 + cert-manager/Let's Encrypt + Google OAuth + helm install. **추가로 실제 배포 활성화**: k3s Google OIDC 신뢰 + iptables pod/service CIDR + RBAC + 클러스터 `oci-a1` 등록. 운영·롤백·함정: [oci-prod-runbook](docs/oci-prod-runbook.md) + [deploy/oci/README §7](deploy/oci/README.md). GCP Phase 1 은 OCI capacity 조기 확보로 **건너뜀**. |
| 11 | [docs/local-e2e.md §9c](docs/local-e2e.md) | 🚧 1차 (2026-09-08) | **e2e 확장.** 로컬/CI kind 대상 스펙 3개 추가 — `05-user-deploy`(폼 검증·RBAC 거부 문장·배포·삭제), `06-admin-draft-save`(미저장 가드·PATCH 저장), `07-error-pages`(not-found). **남은 것**: 라이브 OCI smoke(프로덕션에 릴리스 생성/삭제 여부 결정 필요), 클러스터 끊김·drift 회수 케이스(kind 에서 재현 방법 필요). |
| 12 | _(미작성)_ | ⏳ deferred | **Stage 2 — release reconciler** (구 Plan 9). 백그라운드 루프로 클러스터 헬스 + 리소스 존재 검증, ServiceAccount 토큰 기반 무인 인증, DB 컬럼(`releases.observed_status`, `last_observed_at`) 추가, leader election. 클러스터 수가 늘거나 다중 페일오버 필요 시 우선. 추정 공수 4–5 영업일. |
| 13 | [plan13-demo-mode](docs/superpowers/plans/2026-09-07-plan13-demo-mode.md) | ✅ 라이브 (PR #2, 2026-09-08 롤아웃) | **데모 모드.** Dex 데모 IdP + 데모 계정 2개(관리자/사용자) + 시드(템플릿 3·릴리스 2) + 6시간 리셋 CronJob + k3s 구조화 인증(Google+Dex) 전환 스크립트. 스펙: [self-improving-loop-design](docs/superpowers/specs/2026-09-07-self-improving-loop-design.md) §4.1. |
| 14 | _(미작성)_ | ⏳ planned | **UX 루프.** Sentry + Umami 계측 → role-review v2(브라우저) → 주간 Routine(이슈만) → `agent-go` 라벨 → claude-code-action draft PR → 결과 로그. 스펙 §4.2. |
| 15 | _(미작성)_ | ⏳ planned | **기록 자동화.** 릴리스 노트 → 블로그, Playwright 데모 영상 자동 녹화, 주간 트래픽 지표 → docs/README. 스펙 §4.3. |
| 16 | [pr-reviewers](docs/superpowers/plans/2026-09-08-pr-reviewers.md) | ✅ 구현 (PR 예정) | **PR 리뷰어 시스템.** `/pr-review` 로컬 스킬 — 7 페르소나 에이전트 + 매니저 + `gh pr create` 훅. 스펙: [pr-reviewers-design](docs/superpowers/specs/2026-09-08-pr-reviewers-design.md). |

참고 — 초기 디자인: [2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md), Plan 2 Admin UX: [2026-04-18-plan2-admin-ux-design.md](docs/superpowers/specs/2026-04-18-plan2-admin-ux-design.md).

각 플랜은 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans` 로 실행. 실행 전 **별도 워크트리** 생성 권장 (각 플랜이 frontend/backend 양쪽 건드림 — 현재 docs 워크트리에 섞지 말 것).

## 확정된 결정 (요약)

자세한 근거는 [docs/brainstorming-summary.md](docs/brainstorming-summary.md) 참조.

| 주제 | 결정 |
|------|------|
| Form factor | 웹 앱 |
| 템플릿 형식 | B안 — pure k8s YAML + 별도 ui-spec 오버레이 |
| End-user 조작 범위 | Level 2 — 추상화된 배포/수정/삭제 + 읽기 전용 관찰(logs/events/pods) |
| 인증 | OIDC/SSO, k8s RBAC를 그대로 사용 (앱은 UX 레이어만 담당) |
| 클러스터 | 다중 클러스터 지원 (드롭다운 선택) |
| 리소스 범위 MVP | A안 — 핵심 워크로드 (Deployment/StatefulSet/DaemonSet/Job/CronJob/Service/Ingress/ConfigMap/Secret/PVC) |
| 리소스 범위 v1.1 | B안 — 관리자가 수동 등록한 CRD 지원 |
| Lifecycle | B안 — Versioned 템플릿, 릴리스는 버전에 pin (Helm/ArgoCD 방식) |
| 템플릿 저장소 | 앱 DB (MVP), Git 연동은 v2 |
| `kuberport` 표기 | **고치지 말 것.** SSH 키·디렉터리의 실제 이름이다 (`~/.ssh/kuberport-oci/oci_kuberport`, gpg 번들, `upload-gha-secrets.sh` 폴백). 초기 오타에서 왔지만 이름을 바꾸면 프로덕션 접속 절차가 문서상 깨진다 — 커밋 `106825c` 에서 "실제 파일명은 유지, 스크립트만 새 이름 우선" 으로 결정. runbook §1 참조 |

## 기술 스택

| 영역 | 항목 | 결정 |
|------|------|------|
| Backend | 언어/프레임워크 | Go + Gin (or Echo) |
| Backend | k8s 클라이언트 | `client-go` |
| Backend | OIDC | `coreos/go-oidc` |
| Backend | DB | SQLite (dev) / Postgres (prod) |
| Backend | DB 마이그레이션 | `atlas` |
| Backend | 배포 | Docker image + Helm chart, **k8s Pod로 실행** |
| Frontend | 프레임워크 | **Next.js 15 (App Router)** |
| Frontend | 스타일 | Tailwind + shadcn/ui |
| Frontend | YAML 에디터 | Monaco (`dynamic import`) |
| Frontend | 폼 | React Hook Form + Zod |
| Frontend | OIDC | `openid-client` + httpOnly 쿠키 |
| Frontend | 배포 | k8s Pod (backend와 같은 Helm chart — 단일 Ingress path 라우팅). 근거: [ADR 0001](docs/decisions/0001-frontend-deployment-helm-over-vercel.md) |
| 통신 | 패턴 | **BFF** — Browser → Next.js Route Handler → Go API → k8s API |
| 레포 | 구성 | 단일 레포, `backend/` `frontend/` `deploy/` 분리 |
| 운영 호스팅 | 인프라 | **3-Phase 결정 트리** (근거: [ADR 0003](docs/decisions/0003-hosting-oci-always-free.md)) — **Phase 2 타겟**: OCI Always Free `VM.Standard.A1.Flex` (ARM Ampere, 4 OCPU / 24GB), $0 영구. **Phase 1 부트스트랩** (OCI A1 capacity 대기 중): GCP 90일 무료 크레딧 + `e2-medium` (서울). **Phase 3 last-resort** (OCI 끝까지 안 잡힘): Hetzner CAX21, €7/월 ([ADR 0002](docs/decisions/0002-production-hosting-hetzner-k3s.md), superseded but preserved). 공통: k3s single-node, cert-manager + Let's Encrypt, Cloudflare DNS, `ghcr.io` 멀티아치(`linux/amd64+arm64`). |
| 운영 호스팅 | CI/CD | GitHub Actions (빌드·푸시) → 초기: ssh + `helm upgrade`. 장기: ArgoCD (GitOps, pull 기반) |

**아키텍처 경계 원칙**
- 비즈니스 로직은 Go 백엔드에만. Next.js Route Handler는 **"인증 쿠키 관리 + 얇은 프록시"** 역할만.
- 사용자 OIDC 토큰은 Next.js 서버 쿠키(httpOnly)에 저장, 브라우저 JS에서 접근 불가.
- Go 백엔드는 받은 토큰을 그대로 k8s API에 포워딩. RBAC 판정은 k8s가.

## 디렉터리 구조

```
kubeport/
├── CLAUDE.md                              ← 이 파일 (세션 진입점)
├── docs/
│   ├── brainstorming-summary.md           ← 브레인스토밍 결정 요약
│   ├── dev-setup.md                       ← 개발 환경 설정 가이드
│   ├── deploy/
│   │   └── images.md                      ← 컨테이너 이미지 멀티아치 빌드/푸시 (GHA + 로컬)
│   ├── superpowers/
│   │   └── specs/                         ← 디자인 스펙 (다음 단계에 생성)
│   └── decisions/                         ← ADR (필요 시 생성)
```

## 세션 시작 시: 개발 환경 먼저 확인

이 프로젝트는 **여러 머신(집/회사, Windows/WSL2/macOS 혼용)** 을 오가며 작업한다.
새 세션을 시작할 때 경로·툴 상태가 머신마다 달라 빌드가 중간에 막히는 문제가 반복되므로,
**코드 작성이나 빌드·설치 명령 실행 전에 다음을 먼저 확인**한다:

1. **현재 위치** (`pwd`): WSL 홈(`~/dev/...`) 또는 macOS/Linux 홈 아래, ASCII·OneDrive 밖 경로인가.
   `/mnt/c/...` · 한글·공백 포함 경로라면 먼저 [docs/dev-setup.md](docs/dev-setup.md) §2 를 읽고 이동.
2. **필수 툴 존재 확인**: [docs/dev-setup.md](docs/dev-setup.md) §4 검증 커맨드 —
   `go version` / `node -v` / `pnpm -v` / `atlas version` / `docker --version` / `kubectl version --client`
   중 빠진 게 있으면 §2(Windows) 또는 §3(macOS/Linux) 설치 절차.
3. **증상 기반 디버깅**: `EBUSY` / "file is being used by another process" / 비정상적으로 느린 IO / `command not found`
   → [docs/dev-setup.md](docs/dev-setup.md) §1 (증상→원인 표) 부터 참조.

새 머신에서 처음 클론했거나 위 확인이 실패하면 → [docs/dev-setup.md](docs/dev-setup.md) 전체.

**Windows 사용자 핵심 요점 (시간 없으면 이것만)**:
1. 리포를 **OneDrive 밖 + ASCII 경로**로 옮긴다 (예: `C:\dev\kubeport`). OneDrive 동기화 + 한글 경로는 `go build` / `pnpm install` 잠금 오류의 주원인.
2. **WSL2 + Ubuntu** 에 코드를 두고 (`~/dev/kubeport`), Docker Desktop 의 WSL Integration 을 켜고, VS Code 는 **Remote-WSL** 로 연다.
3. `/mnt/c/...` 경로에 코드를 두지 않는다 — IO 가 5~20배 느리다.
4. 툴(`go`, `node`, `pnpm`, `atlas`, `kubectl`, `docker`)은 **WSL 쪽**에 설치. Windows 쪽 설치와 섞이면 PATH 충돌.

macOS/Linux 는 그냥 Homebrew/apt 로 설치. 자세한 단계·검증 커맨드·함정 체크리스트는 `docs/dev-setup.md` 참조.

## 작업 시 규칙

- **코드 스캐폴딩 금지**: 디자인 스펙 작성 + 사용자 승인 전까지 코드 파일 생성 금지 (`package.json`, `go.mod`, `src/` 등).
- **새 디자인 스펙**: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 경로로 작성.
- **새 결정이 나오면**: `docs/brainstorming-summary.md`를 먼저 업데이트. 큰 결정은 `docs/decisions/`에 ADR 추가.
- **브레인스토밍 재개 시**: 이 파일과 `docs/brainstorming-summary.md`를 먼저 읽고 시작.
- **지속성은 docs 우선, memory 는 보조**: Claude auto-memory 는 머신·프로파일에 묶여
  다른 기기에서 세션을 재개하면 **로드되지 않는다**. 프로젝트 결정·컨텍스트·후속 세션에서
  재사용되어야 할 내용은 반드시 `docs/` 아래(ADR, `brainstorming-summary.md`, specs,
  `dev-setup.md` 등)에 남기고 — 큰 결정은 `docs/decisions/` 에 ADR 로. memory 에는 개인
  선호·세션 로컬 힌트 정도만 저장.

## Git identity (commit 전 확인 필수)

이 프로젝트의 유일한 author email 은 `shyuniz@naver.com`.
commit 전에 `git config user.email` 이 이 값인지 반드시 확인하고, 다르면
`git config user.email shyuniz@naver.com` 으로 설정 후 commit.
다른 머신에서 처음 작업하면 user.name 도 `shyuniz` 로 맞춤.

## 코드 리뷰

- **PR 은 `/pr-review` 로 올린다**: 7개 페르소나(user/admin/design/master/security/ai + manager)가
  diff 와 라이브 데모를 리뷰 → `.claude/reviews/<branch>.md` 기록 (브랜치의 `/` 는 `__` 로 치환) → `gh pr create`(P0 시 draft) →
  PR 코멘트 → 기존 문제는 `reviewer:<persona>` 라벨 이슈. 기록 없이 `gh pr create` 는 훅이 막는다
  (실수 방지용 소프트 가드; 우회 `PR_REVIEW_SKIP=1` 은 긴급 시만). 설치 관련 변경은 `--deep`.
  기록 파일은 **작업 중인 워크트리의** `.claude/reviews/` 에 쓰인다(`.gitignore` 대상) — 훅도 세션
  cwd 기준으로 찾으므로, PR 을 만들기 전에 워크트리를 지우면 기록도 같이 사라진다.
  새로 만든 `.claude/agents/*` 는 세션 재시작 후에만 `subagent_type` 으로 보이며, 스킬에 파일 본문
  폴백이 있다. 스펙: [pr-reviewers-design](docs/superpowers/specs/2026-09-08-pr-reviewers-design.md).
- **푸시 전 셀프 리뷰 필수**: 커밋 전에 변경된 코드를 직접 리뷰한다.
  체크리스트: IDOR/인증 누락, 에러 시 롤백/정리 누락, 입력 검증 누락, 불필요한 메모리 할당, context 취소 미처리.
- **code-reviewer 에이전트**: 변경 파일 3개 이상인 커밋에서는 푸시 전에
  `superpowers:code-reviewer` 에이전트를 돌린다. 별도 컨텍스트에서 코드를 처음 보는
  시각으로 분석하므로 플랜 대비 누락, 보안 이슈, 테스트 커버리지 갭 등 구조적 문제를
  잡는 데 효과적이다. 1~2파일 소규모 변경은 셀프 리뷰만으로 충분.
- **Gemini 리뷰**: 수동 트리거 (`/gemini review`). 수정이 완료된 최종 코드에서
  한 번만 실행한다. 자동 리뷰는 중간 커밋마다 달려 이전 코드 지적이 반복되므로 끔
  (`auto_review: false`).

## PR 작성

- **언어**: PR 제목·설명·본문은 **한국어**로 작성한다 (`gh pr create --title ... --body ...` 의 자유 텍스트 모두). 1차 reviewer 가 한국어 환경에서 보기 때문에 의도 전달이 가장 명확.
- **원문(영어) 유지**: 개별 commit 메시지(`feat(scope): ...`), 코드 블록·로그 발췌·CLI 명령, 기술 식별자(함수명·파일 경로·환경변수). PR 제목의 `type(scope):` 접두어도 영문 유지 — 본문/뒷부분만 한국어.
- **본문 구조**: 자유롭게 구성하되 `## 요약` / `## 테스트 계획` 같은 한국어 헤더 권장. 체크박스(`- [ ]`)는 그대로.

## 테스트

**TDD**: 플랜의 각 태스크는 "실패 테스트 → 구현 → 통과" 순. 상세는 [docs/testing.md](docs/testing.md).

**레이어**:
- **Unit** (외부 의존 없음) — 예: `TestHealthz`
- **Integration** (로컬 compose: postgres + dex) — 현재 기본. 예: `internal/store/*_test.go`
- **e2e** (Playwright, 로컬 kind) — **로컬에서 먼저 돌린다**: `scripts/e2e/doctor.sh` → `up.sh` → `backend.sh`/`frontend.sh` → `seed.sh` → `run.sh` ([docs/local-e2e.md §0](docs/local-e2e.md)). 어느 PC 에서든 같은 순서, 전부 멱등. CI `playwright.yml` 은 백스톱(느리고 가끔 kind 플레이크).

**기본 커맨드** (컴포즈 기동 상태 가정):
```bash
docker compose -f deploy/docker/docker-compose.yml up -d
cd backend && go test ./...
```

**환경 변수**: `TEST_DATABASE_URL` 미지정 시 `postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable` 기본값.

**관례**:
- 통합 테스트의 유니크 키는 `time.Now().Format("150405.000000")` (마이크로초 포함 — 초 단위는 재실행 시 충돌).
- 통합 테스트에서 `t.Skip` 경로는 아직 미구현 — 컴포즈 없이는 실패함 ([docs/testing.md §6](docs/testing.md) TODO).

## 용어 (한국어 문서 기준)

- **템플릿(Template)** — 관리자가 만드는 k8s 리소스 청사진 (`resources.yaml` + `ui-spec.yaml` 한 쌍, 버전 관리됨).
- **릴리스(Release)** — 템플릿을 특정 값으로 실제 클러스터에 배포한 인스턴스.
- **관리자(Admin)** — 템플릿 작성자. k8s 숙련자 가정.
- **일반 사용자(User)** — 템플릿 소비자. k8s 지식 없을 수 있음.
- **ui-spec** — 템플릿의 어떤 경로를 사용자에게 어떤 이름/타입으로 노출할지 선언하는 오버레이.

## 남은 브레인스토밍 토픽

1. Visual Companion 사용 여부
2. 아키텍처 (컴포넌트, 데이터 흐름, 데이터 모델)
3. 기술 스택 (백엔드 / 프론트엔드 / DB)
4. UI 목업 (관리자 템플릿 에디터, 사용자 카탈로그 / 배포 폼 / 릴리스 상세)
5. 앱 자체의 배포 모델 (Helm chart? Docker compose? 단일 바이너리?)

## 레퍼런스 제품

- **Octopod** (오픈소스, Haskell) — 가장 가까운 레퍼런스. Helm 기반 셀프서비스 포털.
- **Backstage Software Templates** — 관리자가 JSON Schema로 템플릿 선언. 스캐폴딩 중심.
- **Rancher App Catalog / OpenShift Templates** — k8s 생태계 전통적 방식.
- **Crossplane Composition** — 추상 API → 실제 리소스 조립. 철학적으로 가장 유사.
- **k9s / Lens / Headlamp** — 운영 감각의 레퍼런스 (단, 이들은 모두 k8s 전문가용).
