# ADR 0002: 운영 호스팅을 Hetzner Cloud + k3s 단일 경로로

| | |
|---|---|
| 날짜 | 2026-04-16 |
| 상태 | Superseded by [ADR 0003](0003-hosting-oci-always-free.md) (2026-04-26) |
| 관련 | [ADR 0001](0001-frontend-deployment-helm-over-vercel.md) (Helm chart 통합 배포), [ADR 0003](0003-hosting-oci-always-free.md) (현행 호스팅 — OCI Always Free) |

> **Superseded 메모**: ADR 0002 작성 시점(2026-04-16)에는 OCI Always Free 가 "계정 사용 불가" 로 후보에서 제외됐다. 2026-04-26 OCI 계정이 활성화되어 ADR 0003 으로 대체된다. 본 문서는 **fallback 옵션** (OCI 정지·capacity 부족·정책 변경 시 즉시 €7/월 이전 경로) 으로 본문 보존. 아래 본문은 그 시점의 결정 그대로이며, 현행 결정은 ADR 0003 참조.

## Context

kubeport 를 MVP 개발 이후 **실제 사용자가 접근 가능한 환경**에 올려 운영하려 한다. 후보는 다음과 같았다.

| 후보 | 월 비용 (소규모) | 평가 |
|------|------------------|------|
| Oracle Cloud Always Free (ARM 4c/24GB) | €0 | 계정 사용 불가 판정 — 후보에서 제외 |
| GCP $300 크레딧 + GKE Autopilot | 90일 €0 → 이후 $40~70 | 크레딧 소진 후 hobby 예산 초과. 장기 운영 비경제적 |
| Civo Managed K8s | $10~15 + LB $10 = ~$25 | 매니지드 k8s 경험 좋으나 크레딧 소진 후 Hetzner 대비 3~4배 |
| DigitalOcean Managed K8s | $12~15 + LB $10 = ~$25 | Civo와 유사 포지션 |
| **Hetzner CAX21 + k3s** | **€7 (≈₩10,000)** | **장기 운영에 압도적 가성비** |

핵심 요구사항:
- 장기(수년) 운영 전제 — 크레딧 기반 무료는 답이 아님
- 공개 접근(https) 가능해야 함 — 로컬 전용은 탈락
- 월 고정비 ₩10,000 수준 이내
- 실제 k8s 경험 (kubeport 자체가 k8s 포털이므로 당연)

## Decision

**운영 환경을 Hetzner Cloud ARM VM + k3s 단일 노드로 고정한다.**

### 구체 스택

| 레이어 | 선택 | 비고 |
|--------|------|------|
| VM | Hetzner **CAX21** (ARM Ampere, 4 vCPU, 8GB RAM, 80GB SSD) | 약 €7/월. 리전: Helsinki/Nuremberg/Falkenstein 중 가까운 곳 |
| OS | Ubuntu 24.04 LTS | |
| k8s 런타임 | **k3s** (single-node) | 경량, 단일 바이너리, Traefik Ingress 내장 |
| TLS | cert-manager + Let's Encrypt (HTTP-01 challenge) | 무료 |
| DNS | Cloudflare | 무료 티어, 선택적으로 proxy 모드로 DDoS/봇 완화 |
| 컨테이너 레지스트리 | GitHub Container Registry (`ghcr.io`) | 무료 (public/private 모두) |
| 이미지 아키텍처 | **`linux/arm64`** (+ `linux/amd64` 선택) | 로컬 dev 에서도 돌려야 하면 멀티아키 빌드 |
| CI | GitHub Actions | 무료 (private repo 월 2000분) |
| CD 초기 | GitHub Actions → ssh → `helm upgrade` | 최단 경로, 5분 세팅 |
| CD 장기 | ArgoCD (k3s 내부 pull 기반 GitOps) | 클러스터 API 외부 노출 없이 배포 가능 |
| Postgres | 초기 in-cluster StatefulSet | 데이터 중요해지면 외부 관리형(Hetzner/Neon/Supabase) 고려 |
| OIDC | Google OAuth 또는 Keycloak Pod 자가호스팅 | 별도 ADR 예정 |

### 예상 월 고정비

- VM: €7
- Hetzner 스냅샷/백업: 월 €1 미만
- 도메인: 연 $10~15 (`.dev` 또는 `.app` 기준, 월로 나누면 $1)
- **합계: 약 €8 (₩11,000 수준)**

트래픽/egress 는 Hetzner 기본 20TB 포함이라 개인/소규모 사용 수준에선 사실상 0.

## Consequences

### 긍정적

- **월 ₩10,000 수준 고정비** 로 실제 공개 서비스 운영이 가능. 크레딧 만료 불안 없음.
- **k3s = 100% 호환 k8s** — kubectl, Helm, ArgoCD, Prometheus, cert-manager 전부 그대로. 기술 이전 가능성 높음.
- **Traefik Ingress 내장** — 별도 Ingress controller 설치 불필요. `LoadBalancer` 서비스는 k3s 의 `servicelb` 로 호스트 포트 점유 (80/443).
- kubeport 자체가 **"첫 번째 자기 앱"** 이 됨 — ArgoCD 가 설치한 릴리스를 kubeport UI 에서 조회/관리하는 dogfooding 구조.
- CI/CD 가 **표준 k8s 패턴** 이라 학습 자산으로 재사용 가능 (GKE/EKS 로 언제든 이식).

### 부정적

- **단일 노드 SPOF** — VM 이 죽으면 서비스 전체 다운. 완화책:
  - Hetzner 스냅샷 일일 자동화 (복구 시간 목표 < 30분)
  - `pg_dump` 를 cronjob 으로 오브젝트 스토리지 백업
  - 장기적으로 2노드 k3s HA (embedded etcd) 로 확장 경로 마련
- **ARM 이미지 필수** — 일부 OSS 이미지가 아직 ARM 미지원. 완화책:
  - `docker buildx` 로 멀티아키 빌드 (arm64 + amd64)
  - 사용 전 `docker manifest inspect` 로 아키텍처 확인
- **Hetzner API/리전 장애 리스크** — EU 단일 리전 의존. 완화책: 백업을 외부 오브젝트 스토리지에 복제.
- **한국/일본 사용자 레이턴시** — EU 리전이라 ping 200~300ms. kubeport 는 관리 도구라 레이턴시 민감도 낮음. 심해지면 Cloudflare proxy 로 정적 에셋 엣지 캐싱.

### 중립

- 로컬 dev 환경은 이 결정과 무관. docker-compose + kind 그대로 유지 (MVP Phase 1 Task 4).
- Helm chart 설계 시 "k3s 특수성" 은 다음만 주의하면 됨: Ingress class = `traefik`, `LoadBalancer` 서비스는 호스트 포트 점유, `local-path` StorageClass 가 기본.

## 마이그레이션 경로 (필요 시)

장래 성장/장애율 악화 시:

1. **2노드 k3s HA** — Hetzner VM 1대 추가 → embedded etcd 클러스터 → 제어 평면 HA. 월 비용 €14.
2. **관리형 k8s** — Civo/DO/GKE 로 이전. Helm chart 는 그대로, values 만 조정 (Ingress class, StorageClass).
3. **다중 리전** — Hetzner 리전 추가 또는 Cloudflare Load Balancing. 사용자 수가 의미 있게 늘면 고려.

각 단계는 kubeport Helm chart 가 클라우드 중립적으로 설계되어 있으면 거의 zero-touch.

## 영향 받는 문서

- `CLAUDE.md` — 기술 스택 표에 "운영 호스팅" 행 추가
- `docs/brainstorming-summary.md` — 새 섹션 "11. 운영 호스팅" 추가
- `docs/superpowers/plans/...-mvp-2-production-deploy.md` (미래 플랜) — 이 ADR 을 기반으로 작성
