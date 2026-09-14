# Container Images — Multi-arch Build & Publish

`backend` (Go API) 와 `frontend` (Next.js BFF) 를 **`linux/amd64` + `linux/arm64`**
멀티아치로 빌드해서 `ghcr.io/shyuni4u/kubeport-{backend,frontend}` 로 푸시.

운영(OCI A1)은 ARM 이고 CI 러너와 대부분의 개발 머신은 x86 이라 **항상 두 아키 모두** 빌드한다
([ADR 0003](../decisions/0003-hosting-oci-always-free.md) §"공통 스택").

## 자동 빌드 — GitHub Actions

`.github/workflows/build-images.yml`. 이미지를 올리는 건 push 이벤트뿐이다:

| 이벤트 | 동작 |
|---|---|
| `push` to `main` | **모든 커밋**(경로 필터 없음) build + push, 두 아키. 태그: `main`, `sha-<7>`, `latest`. 배포(`deploy.yml` → `kubeport-deploy`)가 `sha-<7>` 을 핀하므로 문서만 바뀐 커밋에도 이미지가 있어야 한다 |
| `push` 태그 `v*.*.*` | build + push, 태그: `1.2.3`, `1.2`, `sha-<7>` |
| `pull_request` to `main` | Dockerfile·`.dockerignore`·`go.mod`/`go.sum`·`package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`·`next.config.ts`·이 워크플로가 바뀔 때만 amd64 build, push 없음(fork PR 도 안전). 보통의 소스 변경은 `ci.yml` 의 `go test`·`pnpm build` 가 덮는다 |
| `workflow_dispatch` | 두 아키 build, push 없음 — 브랜치에서 "arm64 가 아직 빌드되나" 만 확인 |

푸시 위치: `ghcr.io/shyuni4u/kubeport-backend` + `ghcr.io/shyuni4u/kubeport-frontend`.

매트릭스로 backend/frontend 병렬 빌드. GHA cache (`type=gha`) 로 두 번째 push 부터 빠름.

### 첫 푸시 후 가시성 (private → public 전환)

GHCR 의 새 이미지는 기본 **private**. K8s 가 imagePullSecret 없이 받게 하려면:

1. GitHub → 우상단 프로필 → **Your packages**
2. `kubeport-backend` 클릭 → 우측 **Package settings**
3. "Danger Zone" → **Change visibility** → Public

(둘 다 해야 함. 이 저장소의 패키지는 이미 public 이라, fork 를 자기 네임스페이스로 올릴 때만 해당한다.
private 으로 두려면 클러스터에 pull secret 을 만들고 차트의 `imagePullSecrets` 에 그 이름을 넣는다.)

## 로컬 빌드 — 검증용

### 사전 세팅 (1회)

```bash
# Docker Desktop / Docker Engine 24+ 필요 (buildx 내장)
docker --version
docker buildx version

# QEMU binfmt 핸들러 — arm64 emulation 위해
docker run --privileged --rm tonistiigi/binfmt --install all

# 멀티아치 builder 생성
docker buildx create --name multiarch --driver docker-container --use
docker buildx inspect --bootstrap multiarch
```

### Backend 빌드

```bash
cd backend
docker buildx build \
  --builder multiarch \
  --platform linux/amd64,linux/arm64 \
  --tag kubeport-backend:dev \
  --build-arg VERSION=local-test \
  .
```

Go 가 cross-compile 이라 두 아키 모두 빠름 (~1분/arch). distroless static 베이스라 결과물 작음 (~85MB — k8s.io/client-go 의존이 큼).

### Frontend 빌드

```bash
cd frontend
docker buildx build \
  --builder multiarch \
  --platform linux/amd64,linux/arm64 \
  --tag kubeport-frontend:dev \
  .
```

⚠️ arm64 는 QEMU emulation 으로 **5~20분** 걸릴 수 있음 (Next.js + node modules). amd64 만
빨리 검증할 거면:

```bash
docker buildx build --platform linux/amd64 --tag kubeport-frontend:dev --load .
```

`--load` 는 단일 플랫폼만 가능 (멀티아치는 manifest list 라 docker engine 이 직접 못 받음).

### 단일 아키 로드 + 실행 테스트

```bash
# 로컬 실행 가능한 amd64 이미지로 빌드
cd backend && docker buildx build --platform linux/amd64 --load -t kubeport-backend:dev .

# 실행 (env 일부만 — 실제 동작은 OIDC/DB 필요해서 여기선 시작 직후 fail 정상)
docker run --rm -e LISTEN_ADDR=:8080 kubeport-backend:dev
# → "OIDC config: set KBP_OIDC_ISSUERS or both OIDC_ISSUER and OIDC_AUDIENCE" — 정상 동작
```

## 이미지 사용

클러스터에는 Helm chart 로 올린다. 이미지 좌표는 `images.backend`·`images.frontend` 이고, 계속 쓸
설치본은 태그를 `sha-<7>` 로 핀한다 — [deploy/helm/kubeport/README.md](../../deploy/helm/kubeport/README.md).

런타임 환경변수는 차트가 values 에서 만든다. 차트 없이 띄울 때의 전체 목록과 각 값의 의미는
[docs/local-e2e.md](../local-e2e.md) §7(backend)·§8(frontend) 이 기준이다 — 목록을 여기 따로 두면
그쪽이 바뀔 때 어긋난다.

## 트러블슈팅

| 증상 | 해결 |
|---|---|
| `multiple platforms feature is currently not supported for docker driver` | container builder 안 만듦. 위 "사전 세팅" 다시 |
| arm64 빌드가 영원히 안 끝남 | QEMU 에뮬레이션이 frontend 에 매우 느림 (5~20분 정상). 진척 확인은 `docker buildx du --builder multiarch` |
| `unable to find image 'tonistiigi/binfmt'` | `docker pull tonistiigi/binfmt` 먼저 |
| `denied: installation not allowed to Create organization package` | GHA workflow 의 `permissions.packages: write` 누락. 워크플로 파일 확인 |
| GHCR 에서 이미지가 안 보임 | private 기본. "Your packages" → settings → visibility 변경 또는 organization 의 default 변경 |
| `pnpm install --frozen-lockfile` 실패 | `pnpm-lock.yaml` 이 outdated. 로컬에서 `pnpm install` 후 lockfile 커밋 |
| backend distroless 에 shell 없어서 디버깅 어려움 | 임시로 `gcr.io/distroless/static-debian12:debug` 로 변경 — busybox 들어 있음 (`debug-nonroot` 태그는 존재하지 않음). 디버깅 끝나면 `:nonroot` 복귀 |
