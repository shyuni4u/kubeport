# Brainstorming Summary

`kubeport`의 브레인스토밍 과정에서 내린 결정과 그 근거를 한곳에 모은 문서.
새로운 결정이 내려지면 이 문서를 먼저 업데이트한 후, 무게 있는 결정은 `docs/decisions/`에 ADR로 추가한다.

## 프로젝트 본질

- **문제**: k8s 리소스(YAML) CRUD는 비전문 사용자에게 진입장벽이 큼. k9s/Lens 같은 도구는 있지만 전부 "k8s를 아는 사람"용.
- **해결**: 관리자(k8s 숙련자)가 **템플릿**을 한 번 만들고, 일반 사용자는 템플릿이 노출한 필드만 폼에서 채워 리소스를 배포/관리. k8s를 몰라도 사용 가능.
- **비유**: Swagger(OpenAPI spec → 인터랙티브 웹 UI)의 k8s 버전.

## 사용자 층

| 층 | 역할 | 주 도구 |
|----|------|---------|
| 관리자 (Admin) | 템플릿 작성 | YAML 에디터 + UI 에디터 (양방향, 상호 변환 가능) |
| 일반 사용자 (User) | 템플릿으로 리소스 배포/관리 | UI 폼 |

> 숙련도는 스펙트럼이지 이분법이 아니다 — 같은 사용자가 상황에 따라 YAML/UI 중 선택할 수 있다.

## 확정 결정 상세

### 1. Form factor: 웹 앱

대안: TUI(k9s 스타일) / 데스크톱(Electron) / CLI+웹 하이브리드.

**선택: 웹**
일반 사용자가 k8s를 모른다는 대전제에서, 설치나 kubeconfig 사전 준비 없이 URL만 알면 접근되는 브라우저 경험이 가장 자연스러움.

### 2. 템플릿 형식: B안 (pure YAML + ui-spec 오버레이)

**구성**
- `resources.yaml` — 배포될 진짜 k8s 매니페스트 (placeholder 없는 순수 YAML)
- `ui-spec.yaml` — 어떤 JSONPath를 어떤 이름/타입/기본값/검증으로 노출할지 선언

**대안**
- A (Helm chart 스타일): `{{ .Values.xxx }}` placeholder + `values.schema.json`
- C (추상 API 우선): 상위 스키마 + 렌더 규칙 (Crossplane 방식)

**왜 B?**
- Swagger 비유에 가장 충실 (순수 YAML이 소스 오브 트루스).
- UI ↔ YAML 양방향 변환이 기술적으로 가장 단순 (placeholder 파싱 없음).
- 관리자가 기존 YAML을 붙여넣고 "노출할 필드만 클릭"하는 UX가 가능.
- Helm placeholder 문법 학습 불필요.

**한계와 미래 보완**
- 반복/조건 로직이 약함 → v2에서 **Helm 임포트**를 B 위에 얹는 플러그인 형태로 보완.

### 3. End-user 조작 범위: Level 2

| Level | 기능 | 평가 |
|-------|------|------|
| 1 | 추상화된 배포/수정/삭제만 | 장애 시 100% 관리자 의존 → 비현실적 |
| **2** | **Level 1 + logs / events / pods 읽기 (추상 용어)** | **MVP** |
| 3 | Level 2 + 제한된 조작 (재시작/스케일 등, 관리자가 템플릿에 허용 표시) | v2로 미룸 — 템플릿 스펙 복잡도↑ |

### 4. 인증: OIDC/SSO → k8s RBAC 직접 사용

- 앱은 **UX 레이어만** 담당. 실제 "이 사람이 이 리소스를 수정할 수 있는가"는 k8s API 서버의 RBAC가 판정.
- 사용자는 앱에서 SSO 로그인 → OIDC 토큰이 그대로 k8s 인증 토큰으로 사용됨.
- RBAC는 OIDC의 email/group에 바인딩 (`User: alice@company.com`, `Group: dev-team`).
- 원칙: **"권한은 k8sconfig 쪽에서 관리"** — 앱이 자체 권한 모델을 갖지 않음.

**배제한 대안**
- BYOK (kubeconfig 업로드): "k8s 모르는 사용자" 컨셉과 근본 충돌.
- 앱 SA impersonation: 앱이 너무 강력한 권한을 쥠. v2의 fallback으로만 고려.

### 5. 클러스터 스코프: 다중

- 드롭다운으로 dev/staging/prod 등 전환.
- 각 클러스터 설정(OIDC issuer, API 서버 주소 등)은 앱 DB에 등록.

### 6. 리소스 범위

**MVP (A안)** — 핵심 워크로드
- Workload: `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `CronJob`
- Network: `Service`, `Ingress`
- Config: `ConfigMap`, `Secret`, `PersistentVolumeClaim`
- Observability (read-only): `Pod`, `Event`, `Log`

**v1.1 (B안)** — 관리자 수동 등록 CRD 지원
- CRD OpenAPI schema 기반으로 폼/뷰 자동 생성.
- 관리자가 상태 필드 매핑을 선언 (예: `.status.phase`).

**원칙**
- 템플릿 **적용(apply)** 은 처음부터 kind-agnostic (B안 템플릿 구조 덕분).
- **뷰어(viewer)** 만 A 범위 kind에 한해 리치, 나머지는 generic YAML 뷰로 폴백.
- 템플릿 하나에 여러 리소스 포함 가능 (Deployment + Service + Ingress = "Web Service" 템플릿).

### 7. Lifecycle: B안 (Versioned)

| 모델 | 설명 | 평가 |
|------|------|------|
| A (스냅샷) | 릴리스가 템플릿 사본을 들고 있음, 수정 전파 없음 | 업그레이드 운영 경로 없음 |
| **B (Versioned)** | **템플릿에 명시적 v1/v2/v3, 릴리스는 버전에 pin** | **Helm/ArgoCD 표준** |
| C (라이브 참조) | 최신 템플릿 즉시 반영 | 프로덕션 사고 위험 |

**B의 동작**
- 관리자 수정 → 새 버전 publish → 기존 릴리스에 "업데이트 가능" 뱃지 → 사용자가 수동으로 마이그레이션 (값 유지).
- 롤백은 버전 되돌리기로 처리.

### 8. 템플릿 저장소: 앱 DB (MVP)

| 저장소 | 평가 |
|--------|------|
| **앱 DB (Postgres/SQLite)** | **MVP — 웹 편집 UX에 가장 자연스러움** |
| k8s CRD (control-plane) | GitOps 친화적이나 웹 편집과 궁합 애매 |
| Git 리포지토리 | 철저한 버저닝, v2에서 연동 고려 (Backstage 스타일) |

## 기존 제품 매핑

| 제품 | 겹치는 부분 | 차별점 |
|------|------------|--------|
| Octopod | 셀프서비스 포털 UX | Octopod은 Helm 전제, 우리는 pure YAML 전제 |
| Backstage Software Templates | 관리자 추상화 선언 | Backstage는 스캐폴딩 중심, 우리는 "배포 후 일상 운영"까지 |
| Rancher App Catalog | 폼 기반 배포 | Rancher는 관리자 템플릿 편집 UX 약함 |
| Crossplane Composition | 추상 API → 실제 리소스 | Crossplane은 선언형 플랫폼, 우리는 런타임 툴 |
| k9s / Lens | 운영 감각 | 이들은 전부 "k8s 아는 사람"용 |

**우리의 포지션**: `Octopod의 셀프서비스 UX + Backstage의 관리자 추상화 + k9s의 운영 감각`의 교집합. 이 셋을 동시에 만족하는 기존 제품은 없음.

## 9. 아키텍처 개요 (승인됨)

5개 컴포넌트 구성:
- **Browser** — Next.js SPA, 사용자 인터페이스
- **Next.js (BFF)** — k8s Pod로 배포 (backend와 동일 Helm chart), 인증 콜백 처리 + Go 백엔드 프록시
- **API Server (Go)** — k8s control 클러스터에 Pod로 배포, client-go 사용
- **App DB (Postgres/SQLite)** — 템플릿 + 릴리스 메타 + 클러스터 등록
- **OIDC Provider** — 외부 (Google/Keycloak/...)
- **Target k8s Clusters** — N개, OIDC-enabled

4가지 핵심 흐름:
1. 로그인: Browser → OIDC → ID token → httpOnly 쿠키
2. 템플릿 CRUD: Browser → Next.js BFF → Go API → App DB
3. 배포: Browser → Next.js BFF → Go API → (App DB 릴리스 기록) + (사용자 토큰으로 k8s API apply)
4. 상태 조회: Browser → Next.js BFF → Go API → 사용자 토큰으로 k8s API 라이브 조회

원칙: **API 서버는 토큰을 그대로 포워딩, 앱 DB는 상태를 캐시하지 않음, 모든 상태는 라이브 조회**.

## 10. 기술 스택

### 백엔드: Go

| 영역 | 결정 | 이유 |
|------|------|------|
| 언어 | **Go** | k8s 생태계 표준 (kubectl/Helm/ArgoCD/k9s/Lens backend 전부 Go) |
| HTTP | Gin (또는 Echo) | 표준 선택지, 미들웨어 풍부 |
| k8s 클라이언트 | `client-go` | 공식 레퍼런스 클라이언트, Watch/Informer 성숙 |
| OIDC | `coreos/go-oidc` | 표준 OIDC provider 검증 라이브러리 |
| DB (dev) | **SQLite** | 설치 없이 개발 가능 |
| DB (prod) | **Postgres** | 표준 선택 |
| 마이그레이션 | `atlas` | 선언적 스키마, gorm 대비 단순 |
| 배포 | Docker + Helm chart | k8s 자체에 Pod로 실행 |

**배제한 대안**: Node.js/TypeScript backend — kubernetes-client 라이브러리가 client-go 대비 덜 성숙 (특히 Watch/Informer), 그리고 v1.1 CRD 지원 시 Go의 dynamic client 이점이 큼.

### 프론트엔드: Next.js 15

| 영역 | 결정 | 이유 |
|------|------|------|
| 프레임워크 | **Next.js 15 (App Router)** | Route Handler 로 BFF 구현, 미들웨어 auth guard, `output: 'standalone'` 로 컨테이너화 용이 |
| 스타일 | Tailwind + shadcn/ui | 빠른 레이아웃 + 접근성 좋은 컴포넌트 |
| YAML 에디터 | Monaco Editor | VSCode와 같은 엔진, `dynamic import`로 SSR 우회 |
| 폼 라이브러리 | React Hook Form + Zod | ui-spec → 동적 폼 생성에 적합 |
| OIDC | `openid-client` | Node 환경 표준 OIDC 클라이언트 |
| 배포 | k8s Pod (backend와 같은 Helm chart) | self-hosted 통합 설치 우선. 단일 Ingress 에서 `/api/*` ↔ `/*` path 라우팅. 상세 근거는 [ADR 0001](decisions/0001-frontend-deployment-helm-over-vercel.md) |

**Vite 대신 Next.js를 선택한 이유**:
1. OIDC 콜백을 Next.js Route Handler에서 서버 사이드 처리 → 토큰을 **httpOnly 쿠키**에 저장 → XSS 내성 (이 앱은 k8s 자격증명을 다루므로 보안 차이가 크다)
2. `middleware.ts`로 인증 가드를 엣지/서버 레벨에서 처리 → 페이지 깜빡임 없음
3. `output: 'standalone'` 로 self-contained Node 이미지가 나와 backend와 같은 Helm chart 에 담기 쉬움 — Vite SPA 는 정적 호스팅 컨테이너가 별도로 필요
4. BFF 패턴(Route Handler 프록시)으로 CORS 설정 제거

### 통신 패턴: BFF (Backend-for-Frontend)

```
Browser  ─→  Next.js Route Handler  ─→  Go API  ─→  k8s API
             (httpOnly 쿠키에서 토큰 꺼냄)    (토큰 포워딩)
```

**A (BFF)를 B (직접 호출)보다 선택한 이유**:
- 토큰이 브라우저 JS에 아예 노출 안 됨 (진짜 httpOnly)
- CORS 설정 0 (단일 origin, Ingress 내부 path 라우팅)
- 한 곳에서 요청 감시/로깅 가능

**아키텍처 경계 원칙**: 비즈니스 로직은 Go 백엔드에만. Next.js Route Handler는 **인증 쿠키 관리 + 얇은 프록시** 역할만. 개발자가 Next.js API에 로직을 스며들게 하는 유혹이 있어 CLAUDE.md에 명시.

### 레포 구성

```
kubeport/
├── backend/         # Go + client-go
├── frontend/        # Next.js
├── deploy/          # Helm chart, Dockerfile
└── docs/
```
Turborepo/nx 같은 모노레포 도구는 MVP에 과함 — 단순 디렉터리 분리로 시작.

## 11. 운영 호스팅: 3-Phase 결정 트리 (OCI 타겟 / GCP 부트스트랩 / Hetzner 최후)

상세 근거와 대안 비교는 [ADR 0003](decisions/0003-hosting-oci-always-free.md). 본래 [ADR 0002](decisions/0002-production-hosting-hetzner-k3s.md) 가 Hetzner CAX21 로 결정했으나, 2026-04-26 OCI 계정이 활성화되면서 ADR 0003 으로 대체. OCI A1 capacity 가 즉시 안 잡히는 경우가 흔해서 GCP 90일 크레딧을 부트스트랩 단계로 살려둠. Hetzner 는 OCI 가 끝까지 안 잡힐 때 last-resort.

| Phase | 트리거 | 호스팅 | 비용 | 기간 |
|---|---|---|---|---|
| **1. Bootstrap** | OCI A1 capacity 못 잡음 | GCP 무료 크레딧 + `e2-medium` (서울 리전) | $0 (90일 한정) | 며칠~몇 주 |
| **2. Target** | OCI A1 확보 | OCI Always Free `VM.Standard.A1.Flex` (4 OCPU / 24GB) | $0 영구 | 무기한 (best case) |
| **3. Last-resort** | GCP 만료 D-30 까지 OCI A1 못 잡음 | Hetzner CAX21 (€7/월) | €7/월 | 무기한 (worst case) |

**공통 스택 (모든 Phase)**

| 레이어 | 선택 |
|--------|------|
| k8s | k3s single-node (Traefik Ingress 내장) |
| TLS | cert-manager + Let's Encrypt |
| DNS | Cloudflare 무료 — A 레코드 IP 만 Phase 이전 시 교체 (TTL 5분) |
| 이미지 레지스트리 | GitHub Container Registry (`ghcr.io`) |
| 이미지 아키텍처 | **`linux/amd64` + `linux/arm64` 멀티아치** — Phase 1 (x86) ↔ Phase 2/3 (ARM) zero-touch |
| CI | GitHub Actions |
| CD | GitHub Actions → ssh → `helm upgrade` (장기적으로 ArgoCD) |
| 백업 (Phase 2 부터) | `pg_dump` 일일 cron → OCI Object Storage (Always Free 10GB) + 외부 복제 (Cloudflare R2 등) |

**예상 월 고정비**: best case Phase 2 직행 = **$1/월 영구 (도메인만)**. worst case Phase 1 → 3 = 90일 무료 후 약 ₩11,000/월.

**배제한 대안**
- OCI Always Free x86 (E2.1.Micro 1c/1GB ×2) — RAM 부족, k3s+Postgres+앱 동시 기동 불가
- Civo / DigitalOcean Managed K8s — ~$25/월, hobby 예산 초과

**주요 리스크와 완화**
- **OCI A1 capacity 부족** (가장 빈번) → Phase 1 GCP 부트스트랩으로 데모 URL 살리고, 백그라운드로 OCI 재시도. 일단 잡히면 절대 종료/재생성 금지. **Always Free 는 홈 리전에서만** 무료라 타 리전 시도는 PAYG 업그레이드 전제
- **GCP 90일 크레딧 만료 = 강제 결정** → 만료 D-30 알림 캘린더 등록. OCI 못 잡으면 Phase 3 Hetzner 로
- **OCI idle reclaim** (7일간 CPU 95p < 20% AND network < 20% AND memory < 20% [A1] — 세 조건 모두 충족 시 강제 종료) → k3s+Postgres 가 상시 동작하면 (b)·(c) 는 안 걸리고, (a) 회피용으로 외부 ping (UptimeRobot / GH Actions Schedule)
- **OCI 정책 리스크** (account reclaim, 정책 위반 강제 종료) → 일일 백업을 OCI 외부(Cloudflare R2 등)에 복제, Phase 3 로 즉시 이전 가능
- **Phase 1 세팅이 2번 될 가능성** → Helm chart 클라우드 중립 + Terraform/cloud-init + DNS IP 만 교체 → 이전 비용 최소화
- **단일 노드 SPOF** (모든 Phase) → 정기 백업, Phase 2 의 OCI 한도 내 두 번째 A1 인스턴스로 2노드 k3s HA 확장 가능
- **ARM 이미지 호환성** → `docker buildx` 멀티아치 빌드 강제 (Phase 1 도 멀티아치로), 서드파티 이미지는 `docker manifest inspect` 확인

**Helm chart 설계 시 기억할 k3s 특수성**
- Ingress class = `traefik`
- `LoadBalancer` 서비스는 `servicelb` 로 호스트 포트(80/443) 점유
- 기본 StorageClass = `local-path` (노드 로컬 디스크)
- OCI Security List + **Ubuntu 이미지의 OS 방화벽(`iptables`)** 에 80/443 인그레스 규칙 명시 필요 (둘 다 기본 차단)
- 외부 MetalLB/cloud LB 컨트롤러 없음 (단일 노드 전제)

## 12. Plan 2 결정 (Admin UX)

Plan 1 (vertical slice) 머지 후 2026-04-18 확정. 이 섹션은 Plan 2 디자인 스펙을 쓰기 전에 합의한 큰 축만 기록한다. 세부 데이터 모델·API 는 spec 에.

### 12.1 편집 모드: UI 모드가 주, YAML 은 read-only preview

- UI 모드가 기본 편집 경로. YAML 패널은 side-by-side 로 렌더된 결과를 보여주는 **읽기 전용** 뷰.
- Plan 1 에 있는 `POST /v1/templates` YAML 페이로드 엔드포인트는 유지 (CI/CLI 등 programmatic push 용).

**배제한 대안**
- YAML ↔ UI 토글 양방향 편집: 동기화 엣지 케이스(formatting, 코멘트 보존 등) 폭증, Plan 2 스코프 밖.
- YAML 모드 완전 제거: Plan 1 레거시 템플릿이 편집 불가해지는 문제.

### 12.2 UI 에디터 스키마 소스: 대상 클러스터의 `/openapi/v2` fetch

- admin 이 편집 시작 시 대상 클러스터를 선택 → 시스템이 해당 클러스터의 OpenAPI 스키마를 fetch → kind 목록과 필드 트리 노출.
- admin 은 kind 선택 후 트리에서 필드별로 (a) 값 고정, (b) 사용자에게 노출 (ui-spec 엔트리 생성) 중 하나를 마킹.

**왜 fetch?**
- 정적 번들은 k8s 버전 drift 로 금방 stale.
- 실제 배포 대상 클러스터의 스키마가 저자 시점 검증의 단일 진실 소스.
- **CRD 자동 지원 포함** — 원래 v1.1 로 미뤄둔 "관리자 수동 등록 CRD" 항목이 이 경로로 자연스럽게 흡수됨. (§6 `v1.1 (B안)` 항목은 이 결정으로 Plan 2 로 앞당겨짐.)

**운영 고려**
- openapi 응답이 큼 (특히 CRD 많은 클러스터는 수 MB ~ 수십 MB) → k8s 1.24+ 의 **OpenAPI v3** 사용 (GVK 별 분할 조회로 페이로드·메모리 절감). 클러스터별 인메모리 LRU 캐시 + 관리자 "refresh" 버튼.
- 권한: openapi 엔드포인트는 기본 discovery 권한 필요 (`system:discovery` ClusterRole, 대부분의 클러스터가 인증된 유저에게 기본 제공).

### 12.3 Plan 1 레거시(YAML) 템플릿 취급: 읽기 전용 preview

- Plan 1 에서 YAML 로 만들어진 템플릿 버전은 새 UI 에디터로 편집 불가.
- 상세 페이지에서 YAML preview + metadata 표시만.
- 새 버전은 처음부터 UI 모드로 재작성 (자동 import 경로 없음).

**왜 import 없음?**
- `resources.yaml` 만으로는 "어떤 필드를 사용자에게 노출할지"를 추측 불가. ui-spec 없는 원본을 UI 모드로 깔끔히 올리는 방법이 없음.
- MVP 시점 레거시 템플릿 수가 적어 재작성 비용이 변환기 구현·유지 비용보다 훨씬 낮음.

**DB 스키마 변경**
- `template_versions.authoring_mode` (enum: `yaml` / `ui`) 신설. YAML preview 전용 vs UI 에디터 편집 가능 여부를 UI 가 구분.

### 12.4 Deprecate: 신규 배포 금지 + 기존 릴리스는 계속

- `template_versions.status` 에 `deprecated` 상태 추가 (현재 `draft` / `published` 에서 확장).
- 카탈로그: deprecated 버전은 배지 표시 + 상세에서만 보임. **신규 배포 버튼 비활성**.
- 기존 릴리스는 버전에 pin 되어 있으므로 동작에 영향 없음.
- "update available" 알림은 non-deprecated 상위 버전이 있을 때만.

### 12.5 버전 히스토리: 목록 + 상태만

- 템플릿 상세에서 `[v1 published, v2 published, v3 deprecated]` 정도로 단순 나열.
- **Plan 2 스코프 아님**: 버전 간 diff, 누가 언제 바꿨는지 감사 로그, 승인 워크플로.
- `created_at` / `created_by_user_id` 는 이미 스키마에 있음. Plan 2 UI 에선 옵션 (표시해도 되고 안 해도 되고).

### 12.6 팀/소유권: 미들 스코프 (Plan 1 decision table 상 "MVP 이후로 미룸"이었던 항목 일부를 Plan 2 로 당겨옴)

**포함**
- 새 엔터티 `teams`, `team_memberships (user_id, team_id, role)`.
- role 은 `editor` / `viewer` 두 가지만.
- `templates.owning_team_id` (nullable) — null 이면 글로벌 템플릿 (Plan 1 호환).
- 편집·publish·deprecate 는 `editor` 멤버만. `viewer` 는 상세 열람만.
- 글로벌 `kubeport-admin` 그룹은 여전히 super-admin (모든 팀 override 가능).

**배제 (Plan 3 이후로)**
- 팀 초대/가입 승인 워크플로 — 팀 생성·멤버 추가는 `kubeport-admin` 이 API 로 직접.
- 릴리스의 팀 소유 개념 — `releases` 는 Plan 1 스키마 유지 (`created_by_user_id` 만). 네임스페이스가 사실상 경계 역할.
- 네임스페이스 ↔ 팀 매핑.
- 팀 단위 카탈로그 가시성 (현재는 publish 된 모든 템플릿이 모든 로그인 유저에게 보임).

**Plan 1 에서 가져갈 호환성**
- `templates.owner_user_id` 는 유지 (단일 생성자 추적용). `owning_team_id` 는 옵션 오버레이.

---

## 13. 사용자 화면 용어: Helm 어휘 현행 유지 (2026-09-07)

Plan 13 데모 모드 마무리 시점에 사용자 화면 용어(카탈로그 / 배포하기 / 릴리스 / 내 릴리스 /
네임스페이스 / 인스턴스)가 비전문 사용자에게 생소하다는 지적이 있었고, "서비스" 비유
(서비스 카탈로그 / 시작하기 / 내 서비스 / 서비스 이름)로 바꾸는 안을 검토했다.

**결정: 현행 유지.** Helm/k8s 어휘를 사용자 화면에도 그대로 쓴다.
- 근거: 초기 타깃 사용자가 플랫폼팀 주변의 개발자라 Helm 어휘가 오히려 익숙하고, Plan 2 의
  "Kubernetes 용어로 보기" 토글(구 "원본 k8s 용어 보기")로 원어 노출은 이미 제어 가능.
  이름을 바꾸면 문서·e2e 셀렉터·스크린샷을 한 번에 갈아야 하는 비용도 있다.
- 재검토 트리거: Plan 14 UX 루프에서 실제 비전문 사용자 세션(리플레이·피드백)에 용어 혼란이
  반복 관찰될 때. 그때는 i18n 파일(`messages/ko.json`·`en.json`)만 바꾸면 되도록 문자열은 계속
  외부화 상태를 유지한다.
- **2026-09-10 부분 수정 (#39 #249 #250)** — 페르소나 리뷰가 배포 폼·릴리스 화면에서 원어 노출과
  같은 대상에 다른 이름이 붙는 것을 짚어, **k8s 오브젝트 이름만** 쉬운 말로 바꿨다:
  - 네임스페이스는 배포 폼·릴리스 목록 모두 **"구역"**(영문 "Area").
  - 리소스 종류는 앱·내부 주소·외부 주소·설정·비밀값 등(`messages/*.json` 의 `kinds.*`).
  - 외부 노출 주소 라벨은 **"외부 주소"**.
  - 원어는 토글을 켜면 `Namespace`·`Pods`·`External Address`·`apps/v1 Deployment` 로 보이고, 관리자는
    토글이 켜진 채로 시작한다.
  - 카탈로그·배포하기·릴리스·내 릴리스·인스턴스 같은 **Helm 어휘는 위 결정대로 유지**한다.

---

## 14. 데모 때문에 느슨해지는 부분은 opt-in 으로 (2026-09-09)

공개 데모(`kubeport.enzo.kr`)를 위해 계정 하나에 관리자 UX 를 열어 주다 보니, 그 편의가 그대로
기본 동작이 되어 자가호스팅 설치본까지 느슨해지는 사례가 나왔다 (주간점검 리뷰의 #48 — 데모
관리자가 전역 카탈로그에 영구 템플릿을 게시할 수 있음).

**결정: 기본값은 항상 안전한 쪽. 데모를 위한 완화는 설치 시 환경변수(차트 값)로 명시적 opt-in.**

- 판단 기준: "이 완화가 없으면 데모를 보여줄 수 없는가?" — 그렇다면 opt-in 플래그로,
  아니라면 그냥 막는다.
- 플래그는 데모 배포에서만 켠다. 문서에는 무엇이 느슨해지는지와 왜 프로덕션에서 켜면 안 되는지를
  함께 적는다 (`KBP_DEV_ALLOW_INSECURE_CLUSTERS` 가 이미 같은 형태다).
- **데모와 무관한 취약점은 플래그로 미루지 않고 고친다.**
- 근거: 리포를 클론해 자기 클러스터에 올리는 사람이 데모 편의의 대가를 대신 치르면 안 된다.
  기본값이 곧 대부분의 설치본이다.

---

## 미해결 (다음 브레인스토밍 토픽)

1. UI 목업 — 템플릿 해부도 / 관리자 템플릿 편집기(YAML/UI 토글) / 사용자 카탈로그 / 배포 폼 / 릴리스 상세
2. 데이터 모델 상세 — Template, Release, Cluster, User 테이블 스키마 + 관계
3. API 디자인 개요 — 주요 엔드포인트
4. 디자인 스펙 문서 작성 — `docs/superpowers/specs/YYYY-MM-DD-initial-design.md`
5. **OIDC IdP 선택** — Google OAuth vs 자가호스팅 Keycloak (ADR 예정)
