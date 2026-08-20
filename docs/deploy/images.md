# Container Images — Multi-arch Build & Publish

`backend` (Go API) 와 `frontend` (Next.js BFF) 를 **`linux/amd64` + `linux/arm64`**
멀티아치로 빌드해서 `ghcr.io/shyuni4u/kubeport-{backend,frontend}` 로 푸시.

ADR 0003 §"공통 스택" 의 "이미지 멀티아치" 강제 항목 — Phase 1 (GCP x86) ↔ Phase 2/3
(OCI/Hetzner ARM) 간 zero-touch 이전을 위해 **항상 두 아키 모두** 빌드.

## 자동 빌드 — GitHub Actions

`.github/workflows/build-images.yml`. 트리거:

| 이벤트 | 동작 |
|---|---|
| `push` to `main` (`backend/**`, `frontend/**`, workflow 파일 변경 시) | build + push, 태그: `main`, `sha-<short>`, `latest` |
| `push` 태그 `v*.*.*` | build + push, 태그: `v1.2.3`, `1.2`, `sha-<short>` |
| `pull_request` to `main` | build only (push 없음 — fork PR 도 안전) |
| `workflow_dispatch` | 수동 트리거 |

푸시 위치: `ghcr.io/shyuni4u/kubeport-backend` + `ghcr.io/shyuni4u/kubeport-frontend`.

매트릭스로 backend/frontend 병렬 빌드. GHA cache (`type=gha`) 로 두 번째 push 부터 빠름.

### 첫 푸시 후 가시성 (private → public 전환)

GHCR 의 새 이미지는 기본 **private**. K8s 가 imagePullSecret 없이 받게 하려면:

1. GitHub → 우상단 프로필 → **Your packages**
2. `kubeport-backend` 클릭 → 우측 **Package settings**
3. "Danger Zone" → **Change visibility** → Public

(둘 다 해야 함. 또는 private 유지하고 k8s 에 `image-pull-secret` 등록 — Helm chart 단계에서 결정)

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
# → "OIDC_ISSUER and OIDC_AUDIENCE are required" log.Fatal — 정상 동작
```

## 이미지 사용 (k8s)

```yaml
# Deployment 발췌 (Helm chart 작성 시 templating)
spec:
  containers:
    - name: backend
      image: ghcr.io/shyuni4u/kubeport-backend:latest   # 또는 sha-abc1234
      ports:
        - containerPort: 8080
      env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: kubeport-db, key: url } }
        - name: OIDC_ISSUER
          value: "https://accounts.google.com"   # 또는 dex
        - name: OIDC_AUDIENCE
          value: "kubeport"
        - name: APP_ENCRYPTION_KEY_B64
          valueFrom: { secretKeyRef: { name: kubeport-app, key: encryption-key } }
```

## 환경변수 — 런타임 필수

### backend (kubeport-backend)
| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgres://user:pass@host:5432/db?sslmode=disable` |
| `OIDC_ISSUER` | ✅ | — | 예: `https://accounts.google.com` 또는 `http://dex:5556` |
| `OIDC_AUDIENCE` | ✅ | — | OIDC client ID |
| `APP_ENCRYPTION_KEY_B64` | ✅ | — | 32-byte AES-256 키의 base64 (DB 의 sensitive 칼럼 암호화용) |
| `LISTEN_ADDR` | | `:8080` | 바인드 주소 |
| `KBP_OPENAPI_CACHE_MAX` | | `64` | OpenAPI 스키마 LRU 캐시 크기 |
| `KBP_DEV_ADMIN_EMAILS` | | (none) | dev only — 콤마 구분 이메일을 admin 으로 격상 |

### frontend (kubeport-frontend)
| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `PORT` | | `3000` | Next.js 바인드 포트 |
| `HOSTNAME` | | `0.0.0.0` | Next.js 바인드 호스트 |
| `NODE_ENV` | | `production` | 이미지 default |
| OIDC / proxy / 기타 | — | — | (Next.js Route Handler 의 BFF 환경변수 — 별도 정리 필요) |

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

## 영향 받는 문서

- `ADR 0003` Phase 1 체크리스트의 "이미지 빌드 파이프라인 멀티아치" 항목 충족
- 후속 Helm chart 작성 시 이 이미지 좌표 (`ghcr.io/shyuni4u/kubeport-{backend,frontend}`) 사용
