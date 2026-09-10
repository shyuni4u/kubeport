# kubeport

k8s 리소스(YAML)를 템플릿화해서, 관리자는 편집하고 비전문 사용자는 폼으로 쓰는 웹 앱.
Swagger가 OpenAPI spec을 UI로 바꿔 주는 것처럼, k8s 리소스를 **추상화된 셀프서비스 포털**로 바꾸는 것이 목표.

## 현재 단계

**🟢 라이브 배포 완료 — https://kubeport.enzo.kr** (OCI Always Free A1, Phase 2 직행). Plan 0~10 실행 완료: 프론트 재설계(0~7) + drift 회수(8) + Helm chart(9) + **OCI 부트스트랩·helm install·Google OIDC·실제 k8s 배포 인프라(10)**. 운영 지식은 반드시 [docs/oci-prod-runbook.md](docs/oci-prod-runbook.md) 참조.

> **▶ 현재 상태 (2026-09-10)** — 데모 가능 상태. 완료 삭제하며 갱신할 것.
> - **라이브 버전은 여기 적지 않는다** — 적을 때마다 썩었다(09-10 에 "rev 15 `c9b1404`" 라고 적힌 동안 실제로는 `7d63336` 이 떠 있었다). `curl -s https://kubeport.enzo.kr/api/healthz` 의 `version` 이 답이고, 리비전 이력은 [runbook §3-3](docs/oci-prod-runbook.md#3-3-배포-확인) 의 `helm history`. 재배포 절차·함정은 [runbook §3](docs/oci-prod-runbook.md#3-재배포-이미지-갱신).
> - **실제 k8s 배포까지 동작**: k3s 가 Google OIDC 신뢰 + RBAC 바인딩 + 클러스터 `oci-a1` 등록 (runbook §5). backend 가 사용자 Google 토큰을 k8s API 로 포워딩.
> - **로그인/로그아웃 정상**, admin 부트스트랩(`auth.devAdminEmails`). **운영 하드닝**: idle-reclaim ping(GHA 10분) + 주간 백업 정책 + 만료 세션 자동 정리.
> - **데모 모드(Plan 13) 라이브** — `/` 에서 관리자/사용자 체험 버튼(Dex 로그인, 비밀번호 화면 표기), `demo` 네임스페이스 격리, **하루 1회 리셋(21:00 UTC = 06:00 KST)**, k3s 가 Google+Dex 구조화 인증. 운영: runbook §5.
> - **2026-09-09 머지분 (PR 23건)** — 페르소나 리뷰어가 연 이슈를 하루에 50건 닫은 날. 주제별로:
>   - **보안 하드닝** (#47 #79 #101): OpenAPI 프록시 path traversal, 템플릿 읽기 인가 부재, BFF catch-all 경로 검증(#51), 빈 `ca_bundle` 이 배포 경로에서만 TLS 검증을 끄던 것, `openapi/refresh` admin·demo 게이트, 500 응답의 DB·업스트림 원문 노출, `/v1/clusters` 접속정보 노출, SSAR 화이트리스트·레이트리밋, 거부된 배포의 액세스 로그. 보안 헤더(HSTS·nosniff·`frame-ancestors 'none'`)는 라이브에서 확인됨.
>   - **에러 계약 완성** (#79 #98 #123): `/v1` 전체가 `Problem{type,title,status,detail,request_id}` 하나로 통일. 라우터에 없는 경로·메서드도 Problem 404/405, SSE 인스트림 에러도 같은 스키마의 `error` 프레임. **`title` 이 분기 키**이고 닫힌 목록은 `openapi.yaml` 의 `ErrorKind` enum — 새 kind 는 `error_shape_test.go`·`openapi_spec_test.go` 가 빌드로 막는다. 기계 클라이언트 가이드: [docs/machine-clients.md](docs/machine-clients.md).
>   - **데모 카탈로그 회귀 복구** (#117): 시더가 `POST /v1/templates` 를 쓰다 자기 데모 게이트(`denyDemo`)에 걸려 **6시간마다 데모가 비워지고 있었다.** DB 직접 시드로 전환 — 게이트는 닫힌 채로 둔다. `repair()` 는 버전 모양이 아니라 "카탈로그가 배포 가능한가" 라는 post-condition 을 본다.
>   - **UI/UX** (#69 #87 #106 #109): 배포 폼(RBAC 거부 시 제출 차단·중복 제출·잔존 에러·슬라이더 트랙), 카탈로그 이름 검색 + 날짜·시각 로케일, **라이트 모드 `--muted`/`--secondary` 를 `--background` 에서 분리**(둘이 같은 값이라 `bg-muted` 표면이 전부 안 보이던 근본 원인), 릴리스 목록에서 비정상만 칩으로 표시.
>   - **CI** (#67 #122): CI 가 `go test`·vitest·eslint 를 실제로 돌리게 됨, next RCE 패치, dependabot. `build-images` 는 **PR 에서 이미지를 push 하지 않고**(빌드만), main 쪽 `paths:` 필터가 없어져 **모든 main 커밋에 `sha-<7>` 태그가 생긴다** — 배포할 태그가 없는 상황이 사라졌다.
>   - **PR 리뷰어 시스템** (#22 #59 #65): `/pr-review` 스킬 + `.claude/agents/*-reviewer.md` 7개 + `gh pr create` 훅. 훅은 **세션 cwd 기준**으로 판정하므로 워크트리에서 작업하면 기록도 그 워크트리에 쓰인다.
> - **남은 것**: (a) **[issue #20](https://github.com/shyuni4u/kubeport/issues/20)** 다른 PC 에서 `scripts/e2e/up.sh` 생성 경로(인증서·kind) 첫 검증, (b) Plan 11 후속 — 라이브 OCI smoke(프로덕션에 릴리스 생성/삭제 여부 결정 필요)·클러스터 끊김/drift 케이스, (c) **리뷰어 이슈 백로그** — 여기 적혀 있던 두 묶음은 모두 닫혔다: 디자인 대비 미달군(#110~#115, #130)은 `c9b1404` 와 마일스톤 C PR 로, 데모 리셋 실패 감시(#105 #119)는 그 전에. 지금 열린 목록은 `gh issue list --label reviewer` 로 직접 본다 — 이 줄에 번호나 건수를 적으면 위의 SHA 처럼 다시 썩는다, (d) **인스트림 에러 중 브라우저 미검증은 `rbac-denied` 1종뿐** — 백엔드 테스트가 유일한 근거다. 이유는 "열린 스트림의 RBAC 을 뺏을 수단이 없어서" 가 아니라 **두 데모 계정이 `pods` 와 `pods/log` 를 항상 같이 갖기 때문**이다 (`demo-rbac.yaml` 의 `demo-admin`·`demo-user` 가 한 rule 에 둘을 나란히 나열한다). 인스트림 `rbac-denied` 는 "릴리스는 읽히는데 로그만 거부" 일 때만 나오므로 라이브에 그 상태가 아예 없다. **kind e2e 는 `pods` 는 주고 `pods/log` 만 빼야 이 경로를 덮는다** — 둘 다 빼면 스트림이 열리기 전에 막혀 pre-open 403(`clusterError`)만 재현된다. `k8s-error` 는 2026-09-10 라이브에서 확인됨. `cluster-auth-denied` 는 2026-09-10 Dex 키 회전 사고 때 **자연 발생해 화면까지 확인됨** — 문구가 `no-pods` 와 갈리고, client-go 원문 누출 0, 눌러도 안 풀리는 종류라 `다시 연결` 버튼이 없다.
> - **2026-09-09 늦게 (PR #144 #145 #140)** — 문서·리뷰 트리아지 규칙, 그리고 **#140: 데모 리셋이 지우기 전에 재시드 가능 여부를 검증한다**(#105 #119 #132). 이 순서 뒤집기가 2026-09-10 에 실제로 값을 했다 — 일시적 Dex 장애로 preflight 가 실패했고, 예전 순서였으면 데모가 비워진 채 방치됐을 것을 아무것도 지우지 않고 멈췄다.
> - **2026-09-10 머지분 (PR 5건)** — #147(#134 로그 탭이 왜 거절됐는지 말한다) · #141(#129 경로 문법 — k8s 라벨 키를 가리킬 수 있게) · #154(#153 리셋 하루 1회 + 배너가 차트 값을 읽게) · #151(미리보기 실패를 Problem 원문 대신 `detail` 로) · #149(#110 #111 #112 #130 상호작용 상태 전용 토큰). **마일스톤 A 종료 — 열린 PR 0건.**
> - **데모 비밀번호 회전은 2단계다** — `helm upgrade` 로 끝나지 않는다. Dex 가 `storage: memory` 라 재시작 시 서명 키가 바뀌고, apiserver 의 JWKS 캐시를 비우지 않으면 **로그인은 되는데 클러스터 호출이 전부 401** 이다. 2026-09-10 에 이걸로 데모가 5분간 멈췄고, 그때 `/healthz` 는 초록이었다. [runbook §5 "데모 모드 운영"](docs/oci-prod-runbook.md#데모-모드-운영-plan-13-2026-09-08-롤아웃-완료).
> - **주의**: 공인 IP `168.107.55.95` 는 ephemeral(stop/start 시 변경). **SSH 키 경로는 머신마다 다르다** — 키를 만든 머신은 `~/.ssh/oci_kuberport`, gpg 번들로 복원한 머신은 `~/.ssh/kuberport-oci/oci_kuberport`. 둘 다 정상이니 통일하지 말고 [runbook §1 "SSH 키 위치"](docs/oci-prod-runbook.md#ssh-키-위치--두-곳-다-정상이다-68) 로 확인할 것 (`kuberport` 표기 자체는 아래 "확정된 결정" 표 — 고치지 말 것). 재배포·RBAC·롤백은 runbook.

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
| 13 | [plan13-demo-mode](docs/superpowers/plans/2026-09-07-plan13-demo-mode.md) | ✅ 라이브 (PR #2, 2026-09-08 롤아웃) | **데모 모드.** Dex 데모 IdP + 데모 계정 2개(관리자/사용자) + 시드(템플릿 3·릴리스 2) + 리셋 CronJob(현재 하루 1회) + k3s 구조화 인증(Google+Dex) 전환 스크립트. 스펙: [self-improving-loop-design](docs/superpowers/specs/2026-09-07-self-improving-loop-design.md) §4.1. |
| 14 | _(미작성)_ | ⏳ planned | **UX 루프.** Sentry + Umami 계측 → role-review v2(브라우저) → 주간 Routine(이슈만) → `agent-go` 라벨 → claude-code-action draft PR → 결과 로그. 스펙 §4.2. |
| 15 | _(미작성)_ | ⏳ planned | **기록 자동화.** 릴리스 노트 → 블로그, Playwright 데모 영상 자동 녹화, 주간 트래픽 지표 → docs/README. 스펙 §4.3. |
| 16 | [pr-reviewers](docs/superpowers/plans/2026-09-08-pr-reviewers.md) | ✅ merged (PR #22·#59·#65) | **PR 리뷰어 시스템.** `/pr-review` 로컬 스킬 — 7 페르소나 에이전트 + 매니저 + `gh pr create` 훅. 스펙: [pr-reviewers-design](docs/superpowers/specs/2026-09-08-pr-reviewers-design.md). |

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
| 데모용 완화 | **기본값은 안전한 쪽, 데모 완화는 설치 시 환경변수로 opt-in** (§14). 공개 데모를 위해 느슨해지는 동작이 자가호스팅 설치본의 기본값이 되면 안 된다. 데모와 무관한 취약점은 플래그로 미루지 말고 고친다 |
| `kuberport` 표기 | **고치지 말 것.** SSH 키·디렉터리의 실제 이름이다 (gpg 번들, `upload-gha-secrets.sh` 폴백). 초기 오타에서 왔지만 이름을 바꾸면 프로덕션 접속 절차가 문서상 깨진다 — 커밋 `106825c` 에서 "실제 파일명은 유지, 스크립트만 새 이름 우선" 으로 결정 |
| SSH 키 **경로** | **머신마다 다르고, 통일하지 않는다** (#68). 키를 만든 머신은 `~/.ssh/oci_kuberport`(평평), gpg 번들로 복원한 머신은 `~/.ssh/kuberport-oci/oci_kuberport`. 한쪽으로 통일하면 반대쪽 머신이 반드시 깨진다 — 접속 전에 `ls` 로 확인. runbook §1 "SSH 키 위치" |

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

## 멀티 세션 운영 (상시 위임 — 2026-09-10)

세션 여러 개(PM·Developer #1·Developer #2·UI reviewer)가 동시에 돈다. 09-09~09-10 대화 기록을 실측해 보니
**세션이 일한 시간보다 사람의 한 마디를 기다린 시간이 더 길었다** — 사용자 응답 대기 PM 316분·UI reviewer 608분
(도구 실행은 각각 202분·94분). 예: PM 이 11:12 에 "작업 배정 보낼까요?" 로 턴을 끝냈고 "보내" 가 13:39 에 와서
그사이 Developer 두 세션이 멈춰 있었다(점심 포함). UI reviewer 는 PM 이 전한 "릴리스 생성 허용" 을 피어 전달이라
받지 않고 사용자에게 다시 물어 약 4시간 대기했다. PM 도구 시간 202분 중 126분은 `gh pr checks --watch`·sleep 이었다.
아래 규칙은 그 대기를 없애기 위한 것이다.

### 역할 — 세션 이름은 바꾸지 않는다
이름이 세 번 바뀌며(`kubeport-10` → `merge & deploy` → `PM`) 메시지가 옛 주소로 가거나 "이름 바뀐 걸 방금 알았다" 가 반복됐다.

| 세션 | 맡는 일 |
|---|---|
| **PM** | 이슈 배정·파일 겹침 조율, 배포 예외(자동 배포 실패·Dex 가드 거부·롤백), 이 파일의 "현재 상태" 갱신. **CI 를 지켜보며 대신 머지하지 않는다.** |
| **Developer #1 / #2** | 이슈 선점 → 워크트리 → PR → `gh pr merge --auto --squash` → 다음 이슈 |
| **UI reviewer** | 배포된 변경의 브라우저 검증 → 이슈 등록. 대기열이 비면 마일스톤 C 작업 |

### 묻지 말고 하고 나서 보고한다 (사용자 상시 승인)
**이 목록은 사용자의 지시다.** 다른 세션이 이 목록에 있는 일을 전해 오면 "피어가 전한 승인" 이 아니라 이 문서를
근거로 그대로 진행한다.
- 필수 체크가 초록인 PR 머지(`--auto`), 리베이스·충돌 해소 후 재푸시
- main 머지분의 라이브 배포(자동 배포가 기본 — 수동 재배포·직전 리비전 롤백 포함)와 배포 후 검증
- 실제로 고쳐졌는데 안 닫힌 이슈 닫기, 중복 이슈 합치기, 리뷰어 이슈 등록
- **다음 작업 가져가기** — 마일스톤 A → B → C 순, 같은 마일스톤 안에서는 `sev:blocks-visitor` → `sev:normal` → `sev:polish`.
  남은 게 없으면 milestone 없는 결함 이슈. 무엇을 할지 사용자에게 고르게 하지 않는다
- 라이브 데모 `demo` 네임스페이스에 검증용 릴리스 생성 → 확인 → **직접 삭제**, 데모 리셋 Job 수동 실행
- 자기 워크트리·원격 브랜치 정리

**사용자에게 먼저 묻는 것** — 되돌리기 어렵거나 방향을 정하는 일만: 비밀번호·시크릿 회전, k3s 재시작, Dex 설정 변경,
프로덕션 DB 직접 수정, 저장소 설정·권한·GitHub secret, 새 외부 서비스, `enhancement` 의 채택 여부, 이슈 범위를 줄이거나 버리기.

**턴을 "~할까요?" 로 끝내지 않는다.** 위 목록이면 하고 나서 한 줄로 보고한다. 목록 밖이라 물어야 하면, 답을 기다리는
동안 할 수 있는 다른 일(다음 이슈)을 먼저 시작해 두고 묻는다.

### 선점과 충돌
- 이슈를 잡으면 **라벨 `claim:<세션>`**(`claim:pm` `claim:dev1` `claim:dev2` `claim:ui`) + 브랜치·워크트리를 적은 코멘트.
  시작 전에 `gh issue view <N> --json labels,comments` 로 이미 잡힌 게 아닌지 본다. PR 이 머지되면 라벨은 이슈와 함께 닫힌다.
- 사용자가 같은 일을 두 세션에 직접 지시했으면 **라벨을 먼저 붙인 쪽이 가진다.** 늦은 쪽은 사용자에게 한 줄 알리고 다음 이슈로
  간다 — 세션끼리 "멈춰 주세요 / 취소합니다" 를 주고받지 않는다(09-09 #134, 09-10 #164 에서 각각 4~6통 오갔다).
- **머지 요청·"CI 초록입니다" 메시지는 보내지 않는다** — auto-merge 가 대신한다. 세션 간 메시지는 파일 겹침, 배포에 영향이
  있는 변경(새 values 키 등), 브라우저 검증 요청일 때만.

### 기다리는 법
- `gh pr checks --watch`·`sleep` 루프로 턴을 붙잡지 않는다. PR 을 올리면 `gh pr merge --auto --squash` 를 걸고 다음 일로 간다.
  결과를 꼭 봐야 하면 `run_in_background` 로 띄운다.
- **auto-merge 의 필수 체크는 `ci.yml` 4개(`audit` `backend` `frontend` `hooks`)뿐이다** (ruleset `protect-main`, 2026-09-10).
  `playwright`·`helm` 은 kind 플레이크로 머지를 막지 않게 필수에서 뺐다 — 빨개도 머지된다. 그래서 **클러스터가 있어야
  도는 테스트**(`backend/internal/k8s`, OpenAPI 프록시 — #121 이후 playwright 잡 안에서만 돈다)나 차트(`deploy/helm/**`)를
  건드린 PR 은 `--auto` 대신 `playwright`/`helm` 결과까지 보고 머지한다. 긴급 시 ruleset 을 끄는 건 사용자 몫이다.
- 라이브가 어느 커밋인지는 `curl -s https://kubeport.enzo.kr/api/healthz` 의 `version` 으로 본다 — 세션끼리 "배포됐나요?" 를 묻지 않는다.

### 브라우저
- Playwright MCP 를 `.mcp.json` 에서 `--isolated`(세션마다 메모리 프로필)로 띄우면 쿠키가 세션끼리 섞이지 않으므로
  **개발 세션도 자기 PR 을 배포 후 Playwright 로 직접 확인해도 된다.** 먼저 `grep -- --isolated .mcp.json` 으로 켜져 있는지
  확인하고(없으면 UI reviewer 에 맡긴다), 설정은 세션을 새로 시작해야 적용된다. `.mcp.json` 수정은 사용자가 한다.
- Chrome 확장(공용 Chrome 프로필)은 여전히 UI reviewer 만 쓴다. `/pr-review` 브라우저 페르소나 순차 실행 규칙도 그대로다.

### 공용 머신에서 테스트
- 고치는 동안은 파일·패키지 단위(`pnpm vitest run <file>`, `go test ./internal/x -run TestY`), **전체 스위트는 푸시 직전 1회** —
  CI 가 어차피 전체를 돈다. 실측: vitest 전체 평균 65초 vs 파일 단위 11초, 한 세션이 전체를 42회 돌렸다.
- 백엔드 통합 테스트는 **세션별 DB** 로: `out=$(scripts/test-db.sh) && eval "$out"` ([docs/testing.md](docs/testing.md) §3.4 — `eval "$(…)"` 형태는 스크립트가 실패해도 성공으로 끝나 테스트가 공용 DB 로 되돌아간다). 공용 DB 에서 두 세션이
  동시에 돌리면 `TestMain` 의 이름 패턴 정리가 서로의 행을 지운다.

## 코드 리뷰

- **리뷰 강도 (2026-09-09 결정)**: `/codex:review` 는 **PR 마다**, `/pr-review` 페르소나는
  **main 머지 체크포인트마다**. 근거: 09-09 하루에 이슈가 56건 생성·26건 종료로 **순증 +30** 이었다.
  PR 마다 전 페르소나를 돌리면 닫는 것보다 여는 게 많아 백로그가 수렴하지 않는다. codex 는 싸고
  신호가 좋아(그날 단 1건 지적이 전체에서 가장 날카로웠다) 매번 유지한다.
- **PR 본문에 `Closes #NN` 을 반드시 쓴다.** 제목이나 표에 번호만 적으면 GitHub 이 링크를 잡지
  않아 **고쳐진 이슈가 계속 열려 있다.** 실제로 PR #106 은 제목이 `(#71 #44 #45 #46)` 인데 #71 만
  닫혔고 나머지 3건은 이미 고쳐진 채로 남아 있었다(09-09 트리아지에서 확인·종료). 여러 건이면
  각 번호 앞에 키워드를 반복한다 — `Closes #81, closes #83` (쉼표 나열은 첫 번째만 닫힌다).
- **리뷰어 이슈는 중복이 생긴다.** `reviewer-fp` 지문은 문구가 달라지면 못 잡는다. #61 이 담고 있던
  결함을 69분 뒤 다른 실행이 #91·#92 로 다시 등록한 사례가 있다. 새 리뷰 이슈를 만들기 전에
  기존 열린 이슈를 제목·주제로 먼저 훑을 것.
- **결함이 아닌 것은 `enhancement` 라벨로 분리한다.** `reviewer:ai` 의 API 확장 요구(MCP 서버,
  스트림, 페이지네이션 등)는 버그가 아니라 제품 방향 결정이라, 결함 목록에 섞여 있으면 영원히
  닫히지 않고 숫자만 부풀린다.
- **묶음은 milestone 으로 고정한다**: A(라이브 데모 복구) · B(클론→설치 경로) · C(대비·반응형).

- **PR 은 `/pr-review` 로 올린다**: 6개 페르소나(user/admin/design/master/security + manager)가
  diff 와 라이브 데모를 리뷰 → `.claude/reviews/<branch>.md` 기록 (브랜치의 `/` 는 `__` 로 치환) → `gh pr create`(P0 시 draft) →
  PR 코멘트 → 기존 문제는 `reviewer:<persona>` 라벨 이슈. 기록 없이 `gh pr create` 는 훅이 막는다
  (실수 방지용 소프트 가드; 우회 `PR_REVIEW_SKIP=1` 은 긴급 시만). 설치 관련 변경은 `--deep`.
  기록 파일은 **작업 중인 워크트리의** `.claude/reviews/` 에 쓰인다(`.gitignore` 대상) — 훅도 세션
  cwd 기준으로 찾으므로, PR 을 만들기 전에 워크트리를 지우면 기록도 같이 사라진다.
  새로 만든 `.claude/agents/*` 는 세션 재시작 후에만 `subagent_type` 으로 보이며, 스킬에 파일 본문
  폴백이 있다. 스펙: [pr-reviewers-design](docs/superpowers/specs/2026-09-08-pr-reviewers-design.md).
- **리뷰 결과의 트리아지 규칙 (2026-09-09 도입)** — 리뷰어를 많이 돌릴수록 이슈가 줄지 않고 늘던 문제의 대응.
  하루에 PR 23건을 머지하면 페르소나 7명 × 23회가 돌아 이슈 83건이 생겼는데, 해소는 PR 단위 직렬이라
  **생산이 소비보다 구조적으로 빠르다.** 그래서 세 가지를 건다:
  - **`sev:*` 라벨** (`blocks-visitor` / `normal` / `polish`) — 심각도가 아니라 **"누가 실제로 겪는가"**.
    기준과 예시는 [finding-schema.md](.claude/skills/pr-review/references/finding-schema.md) "영향도".
    한 실행에서 `blocks-visitor` 가 3건을 넘으면 기준을 잘못 잡은 것이다.
  - **신규 API 표면 요구는 이슈가 아니라 [docs/api-agent-backlog.md](docs/api-agent-backlog.md)** — 실제 호출자가
    없는 상태의 `ai-reviewer` 제안은 문서로 접는다. 단 **이미 문서화된 계약 위반은 이슈**다(그건 버그).
    이 규칙으로도 소음이 절반밖에 안 줄어 **`ai-reviewer` 자체를 2026-09-10 에 껐다** — 적중률
    22건 중 7건. 끈 이유·재개 조건·그동안 비는 표면은 [api-agent-backlog §비활성화](docs/api-agent-backlog.md#ai-reviewer-비활성화-2026-09-10).
  - **기본은 diff 범위**. 전면 감사(전 화면 전수 실측)는 `/pr-review --full` 로 따로. `scope: existing` 은
    페르소나당 최대 3건, 같은 근본 원인의 측정값 N개는 finding 1건으로 묶는다.
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
- **CI** — `.github/workflows/ci.yml` 이 모든 PR 에서 backend(compose + atlas + `go test -p 1 ./...`)·frontend(`pnpm typecheck`/`lint`/`test`)·`pnpm audit`·훅 테스트를 돌린다. e2e 는 `playwright.yml`, 차트는 `helm.yml`.

**기본 커맨드** (컴포즈 기동 상태 가정):
```bash
docker compose -f deploy/docker/docker-compose.yml up -d
cd backend && go test ./...
```

**환경 변수**: `TEST_DATABASE_URL` 미지정 시 `postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable` 기본값.
`KBP_REQUIRE_DEX=1` 이면 dex 미기동을 skip 대신 실패로 처리(CI 전용), `SKIP_OIDC` 는 dex 기반 테스트를 무조건 skip — 둘을 함께 주면 에러.

**관례**:
- 통합 테스트의 유니크 키는 `time.Now().Format("150405.000000")` (마이크로초 포함 — 초 단위는 재실행 시 충돌).
- dex 를 쓰는 `internal/auth` 테스트는 dex 가 안 떠 있으면 `t.Skip` 한다 — 인증서가 없는 새 클론에서도 `go test ./...` 는 초록이다. CI 는 `KBP_REQUIRE_DEX=1` 로 skip 대신 실패시킨다. postgres 를 쓰는 `internal/store`·`internal/api` 는 아직 skip 경로가 없어 컴포즈가 필요하다 ([docs/testing.md §6](docs/testing.md)).
- `go test ./...` 를 병렬로 돌리지 말 것 — `internal/api` 의 `TestMain` 이 이름 패턴으로 공유 DB 를 정리하는데 `internal/store` 가 같은 접미사를 쓴다. CI 는 `-p 1`.

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
