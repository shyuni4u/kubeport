# Plan 9 — Helm Chart MVP (2026-04-29)

> **Status**: 📝 draft. Plan 8 (release stale cleanup Stage 1) 머지 후 후속.
> **번호 재배치**: 기존 CLAUDE.md 의 Plan 9 자리 (Stage 2 release reconciler — 미작성, deferred) 는 본 플랜이 잡고, reconciler 는 **Plan 12 (deferred)** 로 밀려난다. 본 PR 에서 CLAUDE.md 표도 함께 갱신. 새 순서:
> - Plan 9 = **Helm chart MVP** (이 문서)
> - Plan 10 = GCP Phase 1 부트스트랩 (별도 플랜 예정)
> - Plan 11 = e2e 확장 (별도 플랜 예정)
> - Plan 12 (deferred) = release reconciler Stage 2

## 동기

ADR 0003 §"공통 스택" 은 모든 Phase 의 배포 단위가 **Helm chart + k3s** 임을 못박았고, ADR 0001 (frontend deployment) 는 frontend 도 backend 와 같은 chart 안에서 단일 Ingress 로 라우팅하도록 결정했다. 그러나 현재 `deploy/` 에는 `docker/` (compose for local) 만 있고 **`helm/` 디렉터리는 비어 있다.**

다음 단계인 **Plan 10 (GCP Phase 1 부트스트랩)** 은 동료 5~10 명에게 데모 URL 을 공유해 첫 사용자 피드백을 받는 단계인데, helm chart 가 없으면 GCP VM 위에서 `helm upgrade` 명령 자체가 성립하지 않는다 — chart 가 Plan 10 의 **하드 블로커**.

또한 ADR 0003 의 Phase 전이 (GCP x86 → OCI ARM → Hetzner ARM) 가 zero-touch 에 가까우려면 chart 가 **클라우드 중립** (Ingress class, StorageClass, OIDC issuer URL, 도메인 만 values 분기) 이어야 한다. 이 플랜은 그 첫 버전을 만든다.

## 범위(Scope)

**IN**:

- `deploy/helm/kubeport/` 위치에 Helm chart 작성. **단일 chart, sub-chart 없음** (in-cluster Postgres 도 같은 chart 의 templates 안에 둠 — `bitnami/postgresql` 은 의존성·라이선스 부담 회피).
- 다음 리소스 템플릿:
  - `backend` Deployment + Service (ClusterIP) + ConfigMap + Secret
  - `frontend` Deployment + Service (ClusterIP) + ConfigMap + Secret
  - `postgres` StatefulSet + Service + PVC + Secret (gated by `postgres.embedded=true`, default true)
  - `Ingress` — 단일 호스트, **`/` → frontend** 한 개 룰만 (BFF 패턴이라 backend 는 in-cluster Service 로만 노출)
  - `Certificate` — cert-manager `ClusterIssuer` 참조 (gated by `tls.certManager.enabled`)
  - 마이그레이션 `Job` — `atlas schema apply` (선언적 — 프로젝트는 `backend/migrations/schema.hcl` + `atlas.hcl` 패턴). Helm hook `pre-install,pre-upgrade`, `weight=-5`
- Values 분기 (클라우드 중립):
  - `ingress.className` (k3s = `traefik`, GKE = `gce`, etc.)
  - `postgres.storageClassName` (k3s = `local-path`, GKE = `standard-rwo`, etc.)
  - `images.{backend,frontend}.{repository,tag,pullPolicy}`
  - `imagePullSecrets` (private GHCR 인 경우)
- Secret 처리 두 가지 모드:
  - `auth.create=true` (default): chart 가 Secret 을 만들고 values 의 `auth.appEncryptionKeyB64` / `auth.oidcClientSecret` / `postgres.password` 사용 (헬름 `--set` 또는 외부 values 파일 권장 — 절대 git 커밋 금지)
  - `auth.existingSecret=<name>`: 외부에서 미리 만든 Secret 참조 (sealed-secrets/external-secrets 통합 가능)
- 두 가지 예제 values 파일:
  - `values.yaml` (default — k3s + cert-manager 가정, in-cluster Postgres on)
  - `values-gcp-phase1.yaml` (Phase 1 부트스트랩 — 도메인 placeholder, Google OIDC issuer URL, k3s)
- CI:
  - `helm lint` (모든 PR)
  - `helm template -f values-gcp-phase1.yaml` 산출물에 대한 **golden snapshot** 테스트 (regression 방어 — 기존 unit test 와 같은 위상)
  - `kind` 위에 `helm install` smoke 잡 — backend `/healthz` + frontend `/` 가 200 인지 확인

**OUT (= 후속 플랜에서 다룸)**:

- **GCP VM 프로비저닝, cloud-init, k3s install, DNS, Cloudflare 설정** → Plan 10
- **이미지 visibility 전환 (private → public)** → Plan 10 의 Phase 1 체크리스트에 흡수 (이미 `docs/deploy/images.md` 에 절차 있음)
- **Postgres 일일 백업 (`pg_dump` cron)** → Plan 10 (Phase 1 은 데이터 유실 허용, 백업은 Phase 2 로 진입할 때)
- **HA / 두 번째 replica / leader election** → 단일 노드 운영이라 불필요. Plan 12+ 에서 다룸
- **ArgoCD / GitOps** → 초기 CD 는 GHA → ssh → `helm upgrade` (ADR 0003 §공통 스택)
- **Ingress 의 path-based 분기** — 현재는 모든 트래픽이 frontend 로 들어가고 frontend BFF 가 backend 로 in-cluster proxy. backend 를 외부에 직접 노출할 일이 없으므로 단순 유지
- **dex sub-chart 자가호스팅** → Plan 10 에서 Google OAuth vs dex 결정. dex 를 쓰게 되면 그때 chart 에 추가
- **e2e 테스트가 chart 산출물에 대해 도는 것** → Plan 11

## 의존성 / 작업 환경

- 본 플랜은 backend / frontend 코드 자체를 수정하지 **않는다.** 환경변수 컨트랙트(아래 §환경변수) 는 이미 main 에 존재.
- 추가 도구: `helm` v3.14+, `helm unittest` plugin (선택 — 우선은 `helm template` + `yq` 기반 grep 어설션 으로 시작, 후속에 unittest 로 마이그레이션 가능). kind 는 이미 local-e2e 에서 사용 중.
- 별도 브랜치 `feat/plan9-helm-chart`, 워크트리 권장. 추정 공수 2.5–3 영업일.
- 이미지는 PR #31 이 푸시한 `ghcr.io/shyuni4u/kubeport-{backend,frontend}` 사용 (멀티아치, `linux/amd64` + `linux/arm64`). Phase 1 (GCP x86) 도 동일 이미지 태그.

## 환경변수 컨트랙트 (현재 main 기준)

chart 가 wire 해야 하는 변수들 — 변경 없음, 기록용.

**backend (`backend/cmd/server/main.go`)**:

| 변수 | 필수 | 출처 |
|---|---|---|
| `LISTEN_ADDR` | optional (default `:8080`) | values |
| `DATABASE_URL` | required | Secret |
| `OIDC_ISSUER` | required | values |
| `OIDC_AUDIENCE` | required | values |
| `APP_ENCRYPTION_KEY_B64` | required | Secret |
| `KBP_OPENAPI_CACHE_MAX` | optional (default 64) | values |
| `OIDC_CA_FILE` | optional (self-signed dex 일 때만) | values + Secret 마운트 |
| `KBP_DEV_ADMIN_EMAILS` / `KBP_DEV_ALLOW_INSECURE_CLUSTERS` | **never in prod** — chart 에서 표면화 안 함 |

**frontend (`frontend/lib/*.ts`)**:

| 변수 | 필수 | 출처 |
|---|---|---|
| `DATABASE_URL` | required | Secret (backend 와 동일) |
| `OIDC_ISSUER` | required | values (backend 와 동일) |
| `OIDC_CLIENT_ID` | required | values |
| `OIDC_CLIENT_SECRET` | required | Secret |
| `OIDC_REDIRECT_URI` | required | values (`https://<host>/api/auth/callback`) |
| `APP_ENCRYPTION_KEY_B64` | required | Secret (backend 와 동일) |
| `GO_API_BASE_URL` | required | values (`http://<release>-backend:8080`, in-cluster Service URL) |
| `NODE_EXTRA_CA_CERTS` | optional (self-signed dex 일 때만) | values + Secret 마운트 |

backend/frontend 가 공유하는 Secret 키 3개 (`DATABASE_URL`, `APP_ENCRYPTION_KEY_B64`, `OIDC` 그룹) 는 단일 Secret 에 모은 뒤 envFrom 으로 주입.

## 파일 구조

```
deploy/helm/kubeport/
├── Chart.yaml
├── values.yaml                              # default (k3s + cert-manager + in-cluster PG)
├── values-gcp-phase1.yaml                   # Phase 1 예시 (placeholder 도메인, Google OIDC)
├── README.md                                # install/upgrade/uninstall 절차
├── .helmignore
├── ci/
│   └── test-values.yaml                     # golden snapshot 의 입력 (CI 에서만 사용)
└── templates/
    ├── _helpers.tpl
    ├── NOTES.txt
    ├── secret.yaml                          # auth.create=true 일 때만 렌더
    ├── backend-configmap.yaml
    ├── backend-deployment.yaml
    ├── backend-service.yaml
    ├── frontend-configmap.yaml
    ├── frontend-deployment.yaml
    ├── frontend-service.yaml
    ├── ingress.yaml
    ├── certificate.yaml                     # tls.certManager.enabled 일 때만
    ├── postgres-statefulset.yaml            # postgres.embedded=true 일 때만
    ├── postgres-service.yaml                # 위 동일
    ├── postgres-secret.yaml                 # 위 동일
    └── migration-configmap.yaml             # schema.hcl + atlas.hcl (initContainers 가 마운트)

.github/workflows/
└── helm.yml                                  # lint + golden snapshot + kind smoke (신규 워크플로우)

CLAUDE.md                                     # 플랜 표 업데이트 (Plan 9 행 + 12 행)
```

## 작업 순서 (TDD)

각 태스크: **실패 어설션 (template 산출물 grep / golden diff / kind curl) → 템플릿 작성 → 통과**.

### T1. Chart skeleton + lint passes

- `Chart.yaml` (apiVersion v2, version 0.1.0, appVersion = git sha 또는 semver)
- 빈 `templates/` + `_helpers.tpl` (이름 prefix 헬퍼)
- `helm lint deploy/helm/kubeport` 가 0 종료
- **테스트**: `helm lint` 자체가 통과하는 것

### T2. backend Deployment + Service + ConfigMap + Secret

- ConfigMap: `LISTEN_ADDR`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `KBP_OPENAPI_CACHE_MAX`
- Secret: `DATABASE_URL`, `APP_ENCRYPTION_KEY_B64` (auth.create=true 일 때만)
- Deployment: 1 replica, image from `images.backend`, envFrom (configmap + secret), `EXPOSE 8080`, readiness `/healthz`, liveness `/healthz`, securityContext nonroot
- Service: ClusterIP 8080
- **테스트**: `helm template ... | yq ...` 로 (a) backend Deployment 가 존재하고 (b) env 에 위 키들이 모두 있고 (c) Service port 가 8080 인지 어설션

### T3. frontend Deployment + Service + ConfigMap (+ 같은 Secret 공유)

- ConfigMap: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `GO_API_BASE_URL` (= `http://<release>-backend:8080`)
- Secret: `OIDC_CLIENT_SECRET` 키 추가 (T2 와 같은 Secret 객체에 합침)
- Deployment: 1 replica, image from `images.frontend`, envFrom, port 3000, readiness/liveness `/` 또는 `/api/health` (next 16 default), nonroot
- Service: ClusterIP 3000
- **테스트**: 위와 동일 패턴 + `GO_API_BASE_URL` 이 backend Service 이름과 매칭되는지

### T4. in-cluster Postgres (gated)

- StatefulSet (replicas=1, image `postgres:16-alpine`), Service (headless), PVC (storageClassName from values), Secret (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`)
- backend/frontend Secret 의 `DATABASE_URL` 이 `postgres.embedded=true` 일 때 자동으로 in-cluster URL 로 채워짐
- `postgres.embedded=false` 일 때는 외부 DB URL 을 values 에서 받음 (Phase 2+ 대비)
- **테스트**: `embedded=true` 일 때 PG StatefulSet 렌더, `embedded=false` 일 때 렌더 안 됨

### T5. Ingress + Certificate

- Ingress: 단일 host, 단일 path `/` → frontend Service 3000
- `ingress.className` values 분기 (default `traefik` for k3s)
- TLS section: `tls.certManager.enabled=true` 일 때 `Certificate` CR + Ingress 의 `tls.secretName` 자동 wire
- `tls.certManager.enabled=false` 일 때는 `tls.existingSecret` 또는 TLS 없음 (HTTP only — 로컬 디버깅용)
- **테스트**: 두 모드(`certManager.enabled` true/false) 의 golden snapshot

### T6. Atlas migration — initContainer (구현 중 hook → initContainer 로 변경)

- **마이그레이션 전략: 선언적 (`atlas schema apply`)** — 프로젝트는 `backend/migrations/schema.hcl` + `atlas.hcl` 로 desired state 를 직접 기술하는 방식 (`docs/local-e2e.md` §3, `docs/testing.md` 참조). 버전 기반(`atlas migrate apply`)으로 전환은 별도 결정사항(Plan 9 범위 밖).
- **위치 변경: Helm hook Job → backend Deployment 의 initContainer.** 로컬 kind smoke 검증 중 발견된 chicken-and-egg 문제 — pre-install hook 은 chart 의 regular 리소스(Postgres StatefulSet/Service)가 아직 생성되기 전에 실행되어, embedded Postgres 가 있는 한 fresh install 에서 atlas 가 DB DNS 조회 자체를 실패. post-install 로 미루면 backend 가 schema 없이 먼저 떠서 CrashLoop. embedded PG 와는 어느 hook 으로도 양립 불가. initContainer 가 fresh install / upgrade / 재시작을 모두 자연스럽게 커버하고, atlas schema apply 는 idempotent 라 매 backend pod 시작 시 재실행되는 비용은 수 초.
- backend Deployment 에 initContainers 두 개:
  1. `wait-for-postgres` — `busybox:1.36`, `nc -z <pg-svc> 5432` 폴링. atlas 는 DNS 실패 시 즉시 종료하므로 TCP 가 열렸는지부터 확인.
  2. `migrate` — `arigaio/atlas:latest` (backend 이미지 distroless 라 atlas binary 없음). image ENTRYPOINT 가 `atlas` 라 `command:` 대신 `args:` 사용 (안 그러면 PATH 에 atlas 없음으로 exec 실패). `args: [schema, apply, --env, prod, --auto-approve]`.
- frontend Deployment 에도 `wait-for-backend` initContainer (`wget /healthz` 폴링) — frontend 가 자체 DB pool 을 가져서 schema 적용 전에 쿼리 시도하면 깨짐.
- 마운트: 별도 `migration-configmap.yaml` (regular 리소스) 으로 chart 내 `files/schema.hcl` + chart 내 `atlas.hcl` env "prod" 블록(`getenv("DATABASE_URL")`) 을 `/migrations` 에 마운트.
- **DATABASE_URL 주입**: `auth.create=true` 면 chart 가 값을 알고 있으므로 직접 env value 로 주입 (Secret 의존 회피, hook timing 영향 없음). `auth.create=false` 면 externalSecret 의 `secretKeyRef`.
- **테스트**: 로컬 kind smoke — helm install 후 모든 Pod Running, `/healthz` 200, `/` 200, postgres 안에 8개 테이블(clusters, releases, sessions, team_memberships, teams, template_versions, templates, users) 모두 생성. golden snapshot 에 ConfigMap + Deployment initContainers 반영.

### T7. Golden snapshot test in CI

- `.github/workflows/helm.yml` — `helm template -f ci/test-values.yaml > rendered.yaml` 후 `git diff` 로 변경 감지
- 새 workflow 가 **PR 마다** 실행 (chart 변경 감지)
- snapshot 갱신 절차 README 에 명시 (`make helm-snapshot` 같은 헬퍼 추가 권장 — Makefile 신설)

### T8. kind smoke test in CI

- 같은 `helm.yml` 에 두 번째 잡:
  - `kind create cluster`
  - cert-manager 설치 (CRD 가 chart 에서 참조됨)
  - `helm install kubeport ./deploy/helm/kubeport -f ci/test-values.yaml --wait --timeout 5m`
  - `kubectl port-forward svc/<release>-backend 8080:8080` 후 `curl /healthz` 200 확인
  - `kubectl port-forward svc/<release>-frontend 3000:3000` 후 `curl /` 200 확인
- OIDC 가 없는 환경에서도 backend 가 startup fail 하지 않게 — chart 의 `OIDC_ISSUER` 가 placeholder 라도 backend `main.go` 는 `oidc.NewProvider` 시점에 fail 함. 그래서 smoke test 는 dex compose 를 옆에서 띄우거나, `OIDC_ISSUER=https://accounts.google.com` 같은 실 issuer 로 정확히 검증함 (provider discovery 만 통과하면 됨, 토큰 검증은 호출 안 됨)
- **테스트**: workflow 자체가 green

### T9. README + values 예제

- `deploy/helm/kubeport/README.md`:
  - install/upgrade/uninstall 명령
  - secret 주입 패턴 (auth.create vs existingSecret)
  - cert-manager 사전 설치 안내
  - 환경별 (k3s, GKE, etc.) Ingress class / StorageClass 매트릭스
- `values-gcp-phase1.yaml`: Plan 10 에서 그대로 `helm upgrade -f` 로 쓸 수 있는 형태로 미리 채움 (도메인은 `<your-domain.example>` placeholder)

### T10. ~~CLAUDE.md 플랜 표 업데이트~~

> 본 doc PR 에서 이미 처리됨 (Plan 9 Helm chart / Plan 10 GCP / Plan 11 e2e / Plan 12 deferred reconciler 행 + "현재 단계" 한 줄 갱신).
> 구현 PR 에서는 **Plan 9 행의 상태만 `📝 draft` → `✅ merged (PR #N)`** 로 토글하면 됨.

## 결정/오픈 이슈

| 항목 | 옵션 | 현재 결정 |
|---|---|---|
| Postgres sub-chart vs in-template | bitnami/postgresql vs 자체 작성 StatefulSet | 자체 작성 — 의존성·라이선스 회피, 단일노드라 충분 |
| atlas 실행 위치 | initContainer vs Helm hook Job | **initContainer** (kind smoke 검증 중 정정) — embedded Postgres 와 hook 의 chicken-and-egg 가 어느 phase 로도 안 풀림. atlas 는 idempotent 라 재시작 비용 수 초로 허용 가능 |
| atlas 마이그레이션 전략 | 선언적(`schema apply`) vs 버전 기반(`migrate apply`) | **선언적** — 프로젝트가 이미 `schema.hcl` 패턴 사용 중. 버전 기반 전환은 별도 결정 |
| TLS 발급기 | cert-manager vs 직접 Secret 주입 | cert-manager 권장 (gated). Phase 1/2/3 모두 Let's Encrypt HTTP-01 가능 |
| Ingress class default | traefik (k3s) vs nginx | traefik — ADR 0003 §공통 스택 |
| 이미지 visibility | private + pullSecret vs public | **public 권장** (운영 마찰 최소). Plan 10 에서 첫 배포 직전 토글 |
| OIDC 자가호스팅 | dex chart 포함 vs Google OAuth 외부 | 본 플랜에서는 **둘 다 지원** — chart 는 issuer URL 만 받음. dex 를 chart 에 포함시킬지는 Plan 10 에서 결정 |

## 검증 (수동 — CI 외)

- `helm install` → kind 위에서 모든 Pod Running, `/healthz` 200
- `helm upgrade` (image tag 바꿔서) → 기존 PVC 유지, downtime < 30s
- `helm uninstall` → PVC 가 남는지 (default `keep`) values 로 토글 가능한지 확인
- `kubectl exec` 로 Postgres 안에 들어가 `\dt` — atlas 가 만든 테이블 존재
- 외부 PG 모드 (`postgres.embedded=false`) — fake URL 로 backend 가 명확히 fail 하는지 (silent default 금지)

## 영향 받는 문서

- `CLAUDE.md` — 플랜 표 (T10 에서 처리)
- `docs/dev-setup.md` — Helm 설치 안내 추가 (선택)
- `docs/deploy/helm.md` — **신규** chart-level 절차 doc (README 와 별개로 deploy 디렉터리 안에서는 README, repo-level 에서는 deploy/helm.md). 이건 Plan 10 직전에 작성해도 됨 (T9 에서 chart README 만 우선)

## 후속 (Plan 10 진입 조건)

- chart 가 main 에 머지됨
- `helm.yml` CI 가 green
- `values-gcp-phase1.yaml` 에 placeholder 도메인 + Google OIDC 가 채워져 있음
- Plan 10 의 첫 태스크: GCP 계정 + e2-medium VM + Cloudflare DNS + 도메인 구입
