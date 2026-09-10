# kubeport

[English](README.md) | **한국어**

> Kubernetes 를 위한 템플릿 기반 셀프서비스 포털.
> 관리자는 YAML + ui-spec 템플릿을 발행하고, 비전문 사용자는 추상화된 폼으로 배포·운영한다.

**상태:** <https://kubeport.enzo.kr> 에서 라이브 운영 중(OCI Always Free A1). 계정 없이 눌러볼 수 있는 데모 모드도 함께 열려 있다. 출시 완료: 관리자 템플릿 에디터, 카탈로그, RBAC 반영 배포 폼, 실시간 로그가 있는 릴리스 상세, DB↔클러스터 drift 회수, 그리고 스택 전체를 한 번에 올리는 Helm chart. 플랜별 진행 상황과 보류 항목은 [CLAUDE.md](CLAUDE.md) 참조.

---

## 왜 만드는가

Kubernetes 를 제대로 운영하려면 여전히 많은 양의 YAML 을 읽어야 한다. 기존 도구들은 각자 일부만 해결한다:

- `k9s` / `Lens` / `Headlamp` — 운영자에겐 훌륭하지만 k8s 지식을 전제로 한다.
- `Rancher` / `OpenShift` 템플릿 카탈로그 — 존재하지만 Helm 에 기대고, 여전히 리소스 수준 개념을 그대로 노출한다.
- `Backstage Software Templates` — 스캐폴딩은 되지만 일상 운영은 다루지 않는다.

`kubeport` 는 그 교집합을 채운다: 관리자가 템플릿을 한 번 작성하면, 팀원 누구나 `Pod` / `Deployment` / `replicas` 같은 필드를 보지 않고도 배포하고 관찰할 수 있다. **"Kubernetes 를 위한 Swagger"** 라고 생각하면 된다 — 하나의 스펙이 클러스터에서 실제로 돌아가는 매니페스트이자, 일반 사용자가 채우는 친근한 폼이 된다.

## 핵심 개념

**템플릿(template)** 은 두 개(선택적으로 세 개) 파일의 묶음이다. 한 쌍이 앱 DB 의 버전 관리되는 레코드 하나로 저장된다.

```
# resources.yaml  — 순수 Kubernetes YAML, placeholder 없음
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25

# ui-spec.yaml  — 어느 JSON 경로를 일반 사용자에게 노출할지
fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "컨테이너 이미지"
    type: string
```

`path` 의 세그먼트는 `[A-Za-z_][A-Za-z0-9_]*` 형태여야 한다. 라벨·애노테이션·ConfigMap 데이터 키처럼 그렇지 않은 키는 따옴표로 감싼다 — 점이 들어 있어도 키 하나로 취급된다: `Deployment[web].metadata.labels["app.kubernetes.io/name"]`. UI 모드 에디터는 자동으로 붙여 주고, ui-spec 을 손으로 쓸 때만 신경 쓰면 된다.

일반 사용자는 두 개의 필드(+ 릴리스 이름)만 있는 폼을 본다. `resources.yaml` 의 나머지는 전부 관리자가 고정한 값이다.

**릴리스(release)** 는 템플릿 버전 한 개를 특정 클러스터 + 네임스페이스에 배포한 인스턴스다. 릴리스는 템플릿 버전에 pin 된다(Helm / ArgoCD 방식). 관리자가 새 버전을 발행해도 동작 중인 릴리스는 계속 돌아가고, "업데이트 가능" 알림만 뜬다.

## 아키텍처 한눈에

```
Browser ── Next.js (k8s Pod, BFF) ── Go API (in k8s) ── Target k8s clusters (N)
              │                         │
              ▼                         ▼
          Postgres                  (사용자 OIDC 토큰을 그대로 포워딩;
       (sessions + meta)             k8s RBAC 가 최종 판정자)
```

- **프론트엔드**: Next.js 15 (App Router), Tailwind + shadcn/ui, YAML 은 Monaco, 동적 폼은 React Hook Form + Zod. Go API 와 같은 Helm chart 안의 k8s `Deployment` 로 배포 — `helm install` 한 번으로 스택 전체가 올라간다.
- **백엔드**: Go 1.26+, Gin, `client-go`, `sqlc`, `atlas`, `coreos/go-oidc`.
- **데이터**: 운영은 PostgreSQL 16 (개발은 SQLite), OIDC + httpOnly 쿠키 세션, 리프레시 토큰은 저장 시 암호화.
- **보안 모델**: 앱은 UX 레이어일 뿐이다. 모든 k8s 쓰기는 로그인한 사용자의 OIDC id_token 으로 수행되므로, 실제 허용 여부는 Kubernetes RBAC 가 결정한다.

전체 내용: [docs/superpowers/specs/2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md).

## 클러스터에 설치하기

자가호스팅은 Helm chart 하나면 된다:

```bash
git clone https://github.com/shyuni4u/kubeport && cd kubeport
helm install kubeport deploy/helm/kubeport --namespace kubeport --create-namespace \
  --set host=kubeport.example.com \
  --set ingress.className=nginx \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=$CLIENT_ID --set oidc.audience=$CLIENT_ID \
  --set-string auth.devAdminEmails=you@example.com \
  --set auth.oidcClientSecret=$CLIENT_SECRET \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set postgres.password=$(openssl rand -hex 24)
```

`ingress.className` 은 클러스터에 맞는 값으로 바꾼다 — GKE `gce`, EKS `alb`,
nginx-ingress `nginx`, k3s `traefik`. 차트 기본값이 `traefik` 이라, traefik 이 없는
클러스터에서는 Ingress 가 만들어지되 **어떤 컨트롤러도 잡지 않는다.** 에러는 안 나고
주소만 영원히 비어 있다.

이 명령은 `latest` 태그를 설치한다. 계속 쓸 설치본이라면
`--set images.backend.tag=sha-<7> --set images.frontend.tag=sha-<7>` 를 붙인다 —
main 커밋마다 하나씩 발행되고, 핀해야 롤백이 가능하다.

먼저 [deploy/helm/kubeport/README.md](deploy/helm/kubeport/README.md) 를 읽는다 —
특히 **"After install — required on every cluster"**. 이 단계를 건너뛰면 앱은 뜨고
로그인도 되지만 **아무것도 배포하지 못한다.**

아래 "빠른 시작" 은 로컬 개발용이다.

## 빠른 시작

```bash
# 머신당 한 번, 0단계보다 먼저: dex 의 issuer URL 이 host.docker.internal 이라는 이름
# 그대로다. 따라서 이 이름이 이 호스트에서 127.0.0.1 로 풀려야 한다. Docker Desktop 이
# 이 항목을 머신의 LAN IP 로 미리 넣어 두는 경우가 많은데, 그러면 **이름은 풀리는데**
# 그 주소에 dex 가 없어서 계속 실패한다.
grep -i host.docker.internal /etc/hosts    # Windows: C:\Windows\System32\drivers\etc\hosts
# 정확히 이 한 줄이어야 한다: 127.0.0.1 host.docker.internal
# 다른 주소로 잡힌 항목은 지운다. 전체 절차: docs/local-e2e.md §1

# 0. dex 가 TLS 로 쓸 인증서 생성. 클론당 한 번 — 이 파일들은 gitignore 대상이라
#    새로 클론하면 없고, 없으면 dex 가
#    "open /config/certs/dex.crt: no such file or directory" 로 죽는다.
#    (k8s 1.30+ 가 http:// OIDC issuer 를 거부해서 로컬에서도 dex 는 TLS 로 뜬다.)
cd deploy/docker/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout dex.key -out dex.crt -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1"
chmod 644 dex.key      # dex 컨테이너가 비루트로 읽어서 600 이면 안 뜬다. 644 가 안전한
                       # 이유는 이게 폐기용 쌍이기 때문이다 — 아래 3단계가 dex.crt 를 CA 로
                       # 신뢰하므로, 공용 머신이라면 이 키를 읽을 수 있는 사람은 당신의
                       # 로컬 IdP 를 사칭할 수 있다. 이 compose 밖으로 재사용 금지.
cd -
# Windows Git Bash 라면 위 openssl 줄 앞에 MSYS_NO_PATHCONV=1 을 붙인다. MSYS 가
# -subj 의 맨 앞 슬래시를 파일 경로로 바꿔 버려서 openssl 이 거부한다
# ("This name is not in that format: 'C:/Program Files/Git/CN=...'").

# 1. 로컬 Postgres + dex (OIDC) 띄우기
docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml ps    # 둘 다 Up (healthy) 여야 한다

# 2. DB 스키마 적용 (atlas.hcl 은 backend/migrations 에 있음)
cd backend/migrations && atlas schema apply --env local --auto-approve && cd ..

# 3. Go API 실행. env 가 필요하다 — 아무것도 안 주면
#    "OIDC config: set KBP_OIDC_ISSUERS or both OIDC_ISSUER and OIDC_AUDIENCE" 로
#    즉시 종료한다. 전체 목록과 각 값의 의미는 docs/local-e2e.md §7.
LISTEN_ADDR=:8080 \
  DATABASE_URL='postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable' \
  OIDC_ISSUER=https://host.docker.internal:5556 \
  OIDC_AUDIENCE=kubeport \
  OIDC_CA_FILE="$PWD/../deploy/docker/certs/dex.crt" \
  APP_ENCRYPTION_KEY_B64="$KBP_KEY" \
  KBP_DEV_ADMIN_EMAILS=admin@example.com \
  go run ./cmd/server
# $KBP_KEY: `export KBP_KEY=$(openssl rand -base64 32)` 로 한 번 만들고 4단계에서 같은
# 값을 쓴다. 프론트엔드가 이 키로 세션 토큰을 암호화하고 백엔드도 같은 키로 설정되므로,
# 값이 다르면 로그인할 때마다 한쪽이 쓴 것을 다른 쪽이 못 읽는다.
# ↑ 로컬 전용: 그룹 검사 없이 이메일만으로 앱 관리자로 격상한다. 이 변수는 프로덕션에서도
#   똑같이 동작한다. 절대 프로덕션에 넣지 말 것.
#
# 기동 로그의 "discovery failed ... (will retry on first use)" 는 dex 가 아직 안 떴을
# 때도 나고, 위 hosts 항목이 틀렸으면 영원히 난다. **/healthz 로는 구분할 수 없다** —
# DB 와 리스너만 보므로 어느 쪽이든 200 이다. dex 에 직접 물어라:
#   curl -ks -o /dev/null -w '%{http_code}\n' \
#     https://host.docker.internal:5556/.well-known/openid-configuration
# 200 이면 정상. 000 이면 그 이름이 dex 가 없는 곳으로 풀린 것이고, 백엔드 로그가
# 무슨 말을 하든 로그인은 되지 않는다.

# 4. 웹 앱 실행 (다른 터미널에서). frontend/.env.local 은 gitignore 대상이고 복사할
#    예시 파일도 없으니 직접 만든다. 모든 값의 의미가 붙은 전체 블록은
#    docs/local-e2e.md §8. 이 빠른 시작에 필요한 최소값:
cd ../frontend
cat > .env.local <<EOF
GO_API_BASE_URL=http://localhost:8080
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=$KBP_KEY
OIDC_ISSUER=https://host.docker.internal:5556
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
EOF
pnpm install
# NODE_EXTRA_CA_CERTS 는 선택이 아니다. openid-client 가 0단계의 자체서명 dex 인증서를
# 신뢰해야 하고, 없으면 로그인 콜백이 인증서 검증에서 실패한다 — 원인을 알려 주는
# 메시지 없이.
NODE_EXTRA_CA_CERTS="$PWD/../deploy/docker/certs/dex.crt" pnpm dev

# 5. http://localhost:3000 접속, alice / alice 로 로그인
```

`scripts/e2e/up.sh` 가 이 `.env.local` 을 만들어 주긴 하지만 kind 클러스터까지 세우고
인증서도 발급한다 — 그건 e2e 경로다. 스택 전체가 필요할 때 쓰고([docs/local-e2e.md §0](docs/local-e2e.md)),
4단계를 건너뛰는 지름길로 쓰지 않는다.

브라우저 → kind 배포까지 가는 전체 로컬 셋업(자체서명 dex cert, Windows hosts 함정, OIDC 일관성 등)은 [docs/local-e2e.md](docs/local-e2e.md) 참조. 위의 "빠른 시작"은 백엔드+프런트+DB 까지만 충분하고, 실제 k8s 클러스터 e2e 는 몇 단계가 더 필요하다.

## 테스트 실행

```bash
# Unit + integration (compose 기동 상태 필요, backend/CLAUDE.md 참조)
make test                      # == cd backend && go test ./...

# End-to-end (kind 클러스터 필요 — docs/local-e2e.md 참조)
export KBP_KIND_API=https://127.0.0.1:6443
make e2e
```

## 필수 도구

- Docker (로컬 Postgres + dex)
- Go 1.26+
- Node 20+, pnpm 10+
- [`atlas`](https://atlasgo.io) CLI, `sqlc`
- `openssl` (0단계 dex 인증서 + 위 설치 명령의 시크릿 생성)
- (설치 전용) [`helm`](https://helm.sh) 3.x — 차트 스냅샷을 재생성할 거라면 CI 와
  같은 **v3.20.2** 로 고정한다. helm 4 는 문서 구분자 앞에 빈 줄을 하나 더 넣어서,
  helm 4 로 갱신한 스냅샷은 내가 만들지도 않은 diff 로 CI 를 깨뜨린다.
- `kubectl` — 테스트 전용이 아니라 **모든 설치**에 필요하다. 차트 README 의
  "After install" 단계와 아래 port-forward 가 전부 kubectl 이다
- (e2e + 아래 "Try it first" 경로) [`kind`](https://kind.sigs.k8s.io) —
  `scripts/e2e/up.sh` 가 쓰고 `scripts/e2e/doctor.sh` 도 검사한다
- `make` — `make test` · `make e2e` · 차트의 `make helm-snapshot` 이 전부 이걸 쓴다.
  Ubuntu/WSL 기본 이미지에는 없다

"클러스터에 설치하기" 는 대상 클러스터에 Ingress 컨트롤러와 cert-manager 가 추가로
필요하다. 둘 다 없이 그냥 띄워 보고 싶으면 차트 README 의
[Ingress·cert-manager 없는 경로](deploy/helm/kubeport/README.md#try-it-first-any-cluster-no-ingress-no-cert-manager)를 쓴다.

OS 별 설치 절차와 Windows 경로 함정은 [docs/dev-setup.md](docs/dev-setup.md).

## 로드맵

작업은 각자 동작 가능한 소프트웨어를 배달하는 세 개의 Plan 으로 쪼개진다:

| # | Plan | 내용 | 링크 |
|---|------|------|------|
| 1 | **Vertical slice** | OIDC 로그인, YAML 모드 템플릿 CRUD, 배포 폼, 릴리스 목록·개요 | [plan](docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md) ✅ |
| 2 | **Admin UX** | UI 모드 에디터(트리 + 메타 + 라이브 프리뷰), publish/deprecate, 버전 히스토리, 팀 | [plan](docs/superpowers/plans/2026-04-18-mvp-2-admin-ux.md) ✅ |
| 3 | **User observability** | 릴리스 로그(SSE), 이벤트, settings 탭, 업데이트 마이그레이션, 자가호스팅용 Helm chart | 출시 완료 — Plan 4~13 은 [CLAUDE.md](CLAUDE.md) ✅ |

MVP 이후로 미룬 것: CRD 지원, Git 연동 템플릿, 팀/RBAC UI, Helm chart 임포트, 릴리스 히스토리.

## 디렉터리 구조

```
kubeport/
├── backend/                          # Go API (Plan 1)
├── frontend/                         # Next.js (Plan 1)
├── deploy/docker/                    # 로컬 compose (Plan 1)
├── deploy/helm/                      # Helm chart (운영 설치용)
├── docs/
│   ├── superpowers/specs/            # 디자인 스펙
│   ├── superpowers/plans/            # 구현 계획
│   ├── decisions/                    # ADR (필요 시 추가)
│   └── brainstorming-summary.md      # 결정의 근거
├── CLAUDE.md                         # Claude Code 세션 진입점
└── README.md
```

## 컨텍스트 빠르게 찾기

- **뭐라도 만들고 싶다** → [CLAUDE.md](CLAUDE.md) 읽고, `docs/superpowers/plans/` 의 현재 플랜으로.
- **특정 결정의 이유가 궁금하다** → [docs/brainstorming-summary.md](docs/brainstorming-summary.md).
- **시스템 전체 그림을 보고 싶다** → [docs/superpowers/specs/2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md).
- **로컬에서 돌려보고 싶다** → 위의 "빠른 시작".
- **스크립트로 API 를 호출하고 싶다** → 계약은 [backend/api/openapi.yaml](backend/api/openapi.yaml), 인증 방법은 [docs/machine-clients.md](docs/machine-clients.md).

## 기여

아직 외부 기여는 받지 않는다 — 시스템의 모양이 아직 안정화 중이다. 버그 리포트 이슈는 지금도 환영한다.

## 라이선스

[MIT License](LICENSE) — 자유롭게 사용·수정·재배포 가능. 저작권 표기와 라이선스 전문만 유지하면 된다.
