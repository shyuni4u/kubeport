# ADR 0003: 호스팅 — OCI Always Free 타겟 / GCP 무료 크레딧 부트스트랩 / Hetzner 최후 보루

| | |
|---|---|
| 날짜 | 2026-04-26 |
| 상태 | Accepted (supersedes ADR 0002) |
| 관련 | [ADR 0001](0001-frontend-deployment-helm-over-vercel.md) (Helm chart 통합 배포), [ADR 0002](0002-production-hosting-hetzner-k3s.md) (Hetzner — superseded, last-resort 으로 보존) |

> **이력 메모**: 본 ADR 의 첫 초안(2026-04-20, status=Proposed)은 GCP 90일 무료 크레딧 + `e2-medium` 으로 파일럿 단계만을 다뤘다. 그 시점엔 OCI 계정을 받지 못해 ADR 0002 도 OCI 를 후보에서 제외했다. 2026-04-26 OCI 계정이 활성화되면서 Always Free ARM Ampere (4 OCPU / 24GB) 가 실효 옵션이 됐다. 다만 A1 capacity 가 항상 즉시 잡히는 게 아니라 며칠~몇 주 기다려야 할 수 있어, GCP 무료 크레딧을 **OCI 확보 전 부트스트랩 단계**로 살려두는 형태로 in-place 재작성한다 (ADR 0002 는 Superseded 표기, 본문은 last-resort fallback 으로 보존).

## Context

kubeport 를 **동료 5~10 명 피드백 단계 + 그 이후 장기 운영**까지 커버하는 호스팅이 필요하다. 두 단계를 따로 세팅하는 비용 (도메인·DNS·이미지·백업) 을 최대한 줄이되, 다음 현실을 반영해야 한다:

- **OCI A1 capacity 부족이 흔하다** — 인기 Always Free 자원이라 신규 인스턴스 생성이 며칠~몇 주 막히는 사례가 일상적. 그동안 데모 URL 이 없으면 동료 피드백 루프가 멈춤
- **OCI 가 끝까지 안 잡힐 가능성도 0 은 아님** — 그 경우의 last-resort 가 명시되어 있어야 함
- **세팅 1회를 지향** 하되, OCI 가 즉시 잡힌다면 부트스트랩은 건너뛸 수 있어야 함

요구사항:

- **공개 https** 접근 가능 — 로컬 전용은 탈락
- **장기(수년) 운영 비용** 이 hobby 예산 (월 ₩10,000 이내) 안
- **k3s + Postgres + Go API + Next.js** 동시 기동을 견디는 RAM (실측 4GB 여유 필요)
- **Helm chart 가 클라우드 중립** — VM 만 갈아끼우면 되도록 (Ingress class, StorageClass 만 values 분기)
- **이미지 멀티아치** — Phase 1 (x86) ↔ Phase 2/3 (ARM) 사이 이전이 zero-touch

후보 (2026-04-26 시점):

| 후보 | 월 비용 | 사양 | 평가 |
|---|---|---|---|
| **OCI Always Free ARM Ampere (A1.Flex)** | **$0 영구** | **4 OCPU / 24GB / 200GB block** | ✅ **Phase 2 (타겟)** — 영구 무료, 사양 최우수. capacity 확보 즉시 이전 |
| **GCP 90일 크레딧 + `e2-medium`** | $0 (90일 한정) → $25~35/월 | 2 vCPU x86 / 4GB | ✅ **Phase 1 (부트스트랩)** — OCI A1 대기 중 데모 URL 살리는 용. 90일 안에 OCI 또는 Hetzner 로 이전 |
| **Hetzner CAX21 (ADR 0002)** | €7/월 (≈₩10,000) | 4 vCPU ARM / 8GB / 80GB | ✅ **Phase 3 (last-resort)** — OCI A1 가 GCP 크레딧 만료까지도 안 잡히면 여기로. 영구 운영 가능 |
| OCI Always Free x86 (E2.1.Micro ×2) | $0 영구 | 1c / 1GB ×2 | ❌ k3s + Postgres + 앱 동시 기동 시 OOM |
| Civo / DigitalOcean Managed K8s | $25~35/월 | 매니지드 control plane | ❌ hobby 예산 초과 |

## Decision

**호스팅을 3-단계 결정 트리로 운영한다.**

```
Phase 1 (Bootstrap)               Phase 2 (Target)            Phase 3 (Last-resort)
──────────────────                 ────────────────             ──────────────────────
GCP 90일 크레딧 + e2-medium  ──→  OCI A1.Flex 4c/24GB    ──→  Hetzner CAX21 (€7/월)
$0 (90일 한정)                    $0 영구 (best case)         $0 영구 (worst case)
                                  ↑                            ↑
       OCI A1 capacity 확보 시 ──┘                            │
       GCP 크레딧 만료 D-30 까지 OCI A1 못 잡으면 ──────────┘
```

- **즉시 OCI A1 가 잡히면** Phase 1 을 건너뛰고 Phase 2 로 직행
- **A1 capacity 가 막히면** Phase 1 GCP 로 데모 URL 을 먼저 띄우고, 백그라운드로 OCI 재시도. 잡히는 시점에 Phase 2 로 이전
- **GCP 90일 크레딧 만료 D-30 까지도 A1 못 잡으면** Phase 3 Hetzner 로 이전 (장기 운영 확정)

ADR 0002 (Hetzner) 는 Superseded 처리하지만 **본문은 Phase 3 last-resort 옵션으로 보존**한다.

### 공통 스택 (모든 Phase)

| 레이어 | 선택 | 비고 |
|---|---|---|
| k8s | **k3s** (single-node) | Helm chart 그대로 재사용 |
| TLS | cert-manager + Let's Encrypt (HTTP-01 challenge) | 무료 |
| DNS | Cloudflare 무료 티어 | A 레코드 → VM 공인 IP. Phase 이전 시 IP 만 교체 (TTL 5분) |
| 컨테이너 레지스트리 | GitHub Container Registry (`ghcr.io`) | 무료 |
| 이미지 아키텍처 | **`linux/amd64` + `linux/arm64` 멀티아치** | Phase 1 = x86, Phase 2/3 = ARM 이라 항상 둘 다 빌드. `docker buildx` |
| CI | GitHub Actions | 무료 (private repo 월 2000분) |
| CD | GitHub Actions → ssh → `helm upgrade` | VM 공인 IP 만 시크릿에서 교체. 장기적으로 ArgoCD |
| Postgres | 초기 in-cluster StatefulSet | Phase 1 의 데이터는 유실 허용 (피드백 단계). Phase 2 진입 시 `pg_dump` 일일 백업 |
| OIDC | Google OAuth 또는 dex Pod 자가호스팅 | 별도 ADR 예정 |

### Phase 1 — Bootstrap (GCP 90일 크레딧)

| 레이어 | 선택 | 비고 |
|---|---|---|
| 계정 | GCP 90일 무료 크레딧 ($300) | 카드 등록 필요. **예산 알림 $1 한도** 설정 → 자동 과금 차단 |
| VM | `e2-medium` (2 vCPU / 4GB / 30GB pd-balanced) | x86_64. 월 $25~35 → $300 크레딧으로 9~12 개월도 가능하나 **만료 = 90일** 이 하드캡 |
| 리전 | `asia-northeast3` (서울) | 한국권 동료 레이턴시 ~30ms |
| 데이터 | 유실 허용 | 피드백 단계라 Postgres 백업 생략. Phase 2 이전 시 dump 1회 |

### Phase 2 — Target (OCI Always Free A1.Flex)

| 레이어 | 선택 | 비고 |
|---|---|---|
| 계정 | Oracle Cloud Always Free | 카드 등록 필요(verification only). PAYG 업그레이드 안 함 (Always Free 모드 유지) |
| VM | **`VM.Standard.A1.Flex`** (Ampere ARM, 4 OCPU / 24GB) | Always Free 최대 한도 |
| 부팅 볼륨 | 100GB block (Always Free 한도 200GB 중 절반) | 나머지 100GB 는 future Postgres PV 용 |
| 리전 | `ap-chuncheon-1` (춘천) 또는 `ap-seoul-1` (홈 리전 — 가입 시 한 번 선택, 변경 불가) | **Always Free 자원은 홈 리전에서만 무료** — 타 리전은 PAYG 업그레이드 필요 |
| OS | Ubuntu 24.04 LTS (ARM) | OCI 공식 이미지 |
| 백업 | `pg_dump` 일일 cron → OCI Object Storage (Always Free 10GB) + 외부 복제 (Cloudflare R2 등) | OCI 계정 정지 리스크 헤지 |

### Phase 3 — Last-resort (Hetzner CAX21)

ADR 0002 본문 그대로. 트리거: GCP 크레딧 만료 D-30 까지 OCI A1 capacity 못 잡음.

### 예상 월 고정비

| Phase | VM | 백업/스토리지 | 도메인 | 합계 |
|---|---|---|---|---|
| 1 (GCP) | $0 (크레딧 내) | $0 | $1 | **$1/월** (90일 한정) |
| 2 (OCI) | $0 영구 | $0 (Object Storage 10GB 무료) | $1 | **$1/월** (영구) |
| 3 (Hetzner) | €7 (~$8) | < $1 (스냅샷) | $1 | **약 €8 (~₩11,000)** (영구) |

Best case (Phase 2 직행): 첫날부터 영구 $1/월. Worst case (Phase 1 → 3): 90일 무료 후 ₩11,000/월.

## Consequences

### 긍정적

- **데모 URL 이 OCI 대기로 인해 막히지 않음** — Phase 1 부트스트랩이 동료 피드백 루프를 즉시 시작
- **OCI 잡히면 영구 무료 + 사양 3배** — Hetzner 대비 24GB vs 8GB
- **Phase 간 이전이 zero-touch 에 가까움** — Helm chart 클라우드 중립, 멀티아치 이미지, DNS A 레코드 IP 만 교체
- **백업 인프라 무료** — OCI Object Storage Always Free 10GB
- **kubeport 자체가 "첫 번째 자기 앱"** — ArgoCD 가 설치한 릴리스를 kubeport UI 로 조회/관리하는 dogfooding

### 부정적

- **Phase 1 세팅이 2번 될 가능성** — GCP 에서 도메인/IP/시크릿 세팅 후, Phase 2 또는 3 로 이전할 때 재세팅. 완화책:
  - Helm chart 는 클라우드 중립 (Ingress class, StorageClass 만 values 분기)
  - Terraform 또는 `cloud-init` 으로 VM 프로비저닝 자동화
  - DNS 는 Cloudflare A 레코드 IP 만 바꿈 (TTL 5분)
  - CD 는 GitHub Actions 시크릿의 VM IP 만 교체
- **GCP 크레딧 만료 = 강제 결정** — 90일 안에 OCI 든 Hetzner 든 결판. 완화: 만료 D-30 알림 캘린더 등록
- **OCI 가 잡혔어도 정책 리스크 잔존**:
  - **A1 capacity 부족** — 인기 리전에서 신규 인스턴스 생성이 며칠~몇 주 막힐 수 있음. 일단 잡히면 절대 종료/재생성 금지
  - **idle reclaim** — Always Free 인스턴스가 **7일간 (a) CPU 95th percentile < 20% AND (b) network < 20% AND (c) memory < 20% (A1 만 해당)** — 세 조건 모두 충족 시 강제 종료 대상 (공식 정책, [OCI 문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)). k3s + Postgres 가 상시 동작하면 (b)·(c) 는 일반적으로 안 걸리고 (a) 는 트래픽 0 일 때 control-plane idle 만으로 95p 20% 미만이 가능하므로, 외부 ping (UptimeRobot 또는 GitHub Actions Schedule) 으로 (a) 회피
  - **계정 정지** — 결제 분쟁/약관 위반 시 사전 통보 짧음. 완화: `pg_dump` 가 매일 OCI Object Storage **외부에도** 복제(Cloudflare R2 등 제2 백업)
  - **PAYG 자동 과금** — Always Free 모드 유지 확인 필수
- **단일 노드 SPOF** (모든 Phase) — VM 이 죽으면 서비스 전체 다운. 완화: 정기 백업, 장기적으로 Phase 2 의 OCI 한도 내 두 번째 A1 인스턴스로 2노드 k3s HA
- **카드 등록 필요** (Phase 1·2 모두) — verification 차원. 완화: 카드 한도 낮은 계좌, GCP 예산 한도 $1 설정

### 중립

- 로컬 dev 환경은 이 결정과 무관. docker-compose + kind 그대로
- ADR 0002 본문에 있던 "k3s 특수성" (Ingress class = `traefik`, `LoadBalancer` 가 호스트 포트 점유, `local-path` 기본 StorageClass) 은 모든 Phase 에 동일 적용

## Phase 전이 트리거

### Phase 1 → Phase 2 (GCP → OCI)

다음 둘 중 하나라도 만족:
1. **OCI A1 인스턴스 확보** (홈 리전 capacity 잡힘)
2. (드물게) GCP e2-medium 이 RAM 부족으로 운영 한계 도달

이전 절차:
- OCI VM 프로비저닝 + Helm chart 재배포
- Postgres `pg_dump` → OCI 로 import
- DNS A 레코드 IP 교체 (Cloudflare TTL 5분)
- GCP VM 셧다운 → 프로젝트 삭제 (자동 과금 차단)

### Phase 1 → Phase 3 (GCP → Hetzner) — worst case

트리거: **GCP 90일 크레딧 만료 D-30** 까지 OCI A1 capacity 못 잡음.

이전 절차: Phase 1 → 2 와 동일하되 대상이 Hetzner. 이미지가 멀티아치라 ARM 그대로 사용.

### Phase 2 → Phase 3 (OCI → Hetzner) — OCI 운영 중 사고 시

다음 중 하나라도 발생:
1. **A1 인스턴스가 강제 종료** + 24시간 이상 재생성 불가
2. **OCI 계정 정지** 또는 정책상 kubeport 워크로드 거부
3. **Always Free 정책 변경** (한도 축소 등)

## 실행 체크리스트

### Phase 1 (Bootstrap, OCI A1 capacity 확보 전에 시작)

- [ ] OCI A1 인스턴스 생성 시도 — **잡히면 Phase 1 건너뛰고 Phase 2 로**
- [ ] (A1 못 잡힘) GCP 계정 + 90일 크레딧 활성화, **예산 알림 $1 한도** 설정
- [ ] `e2-medium` VM (`asia-northeast3`, Ubuntu 24.04) 프로비저닝
- [ ] 도메인 + Cloudflare A 레코드 → GCP VM IP
- [x] **이미지 빌드 파이프라인 멀티아치 (`linux/amd64` + `linux/arm64`)** — 이 시점에 강제, Phase 2/3 이전 시 zero-touch ([docs/deploy/images.md](../deploy/images.md), `.github/workflows/build-images.yml`)
- [ ] Helm chart 작성 + GCP VM 에 `helm upgrade`
- [ ] cert-manager + Let's Encrypt
- [ ] OIDC (Google OAuth 또는 dex)
- [ ] 동료에게 URL 공유 + 백그라운드로 OCI A1 재시도 cron
- [ ] **GCP 만료 D-30 알림 캘린더 등록** (Phase 3 결정 데드라인)

### Phase 2 (Target, OCI A1 확보 즉시)

- [ ] OCI 계정 verification (카드 등록, Always Free 모드 확인)
- [ ] `VM.Standard.A1.Flex` (4 OCPU / 24GB / 100GB boot) 프로비저닝 — 홈 리전
- [ ] Security List **및 OS 방화벽 (`iptables` — Ubuntu 이미지에서 기본 차단됨)** 80/443 인그레스 + SSH 22 (소스 IP 제한) 허용
- [ ] k3s install + Traefik Ingress 동작 확인
- [ ] (Phase 1 에서 왔다면) Postgres `pg_dump` import
- [ ] Helm chart 재배포 (멀티아치 이미지라 그대로) + cert-manager 재발급
- [ ] DNS A 레코드 IP 교체 → OCI VM
- [ ] Postgres StatefulSet + 일일 `pg_dump` cron → OCI Object Storage
- [ ] **백업 외부 복제** (Cloudflare R2 또는 Hetzner Storage Box) — OCI 정지 리스크 헤지
- [ ] OCI fallback 트리거 **외부** 모니터링 (UptimeRobot 또는 GitHub Actions Schedule — VM 내부 cron 은 VM 다운 시 침묵하므로 무용). 인스턴스 health + 계정 상태 + idle reclaim 임계 (CPU 95p / network / memory 20% 라인) 감시
- [ ] (Phase 1 정리) GCP VM 셧다운 → 프로젝트 삭제

### Phase 3 (Last-resort, OCI 끝까지 안 잡히거나 운영 중 사고)

ADR 0002 본문의 실행 절차 따라감. Helm chart / 이미지 / DNS / 백업 절차 모두 재사용.

## 영향 받는 문서

- `CLAUDE.md` — 기술 스택 표의 "운영 호스팅" 행을 3-Phase 결정 트리로 갱신
- `docs/brainstorming-summary.md` — §11 호스팅 섹션을 Phase 1/2/3 구조로 재작성
- `docs/decisions/0002-production-hosting-hetzner-k3s.md` — header status `Superseded by ADR 0003` (본문 보존, Phase 3 last-resort)
- 미래 Helm chart 플랜 — 클라우드 중립 설계 명시 (Ingress class, StorageClass 를 values 분기), 멀티아치 이미지 빌드 강제 (Phase 1 ↔ 2/3 이전 zero-touch)
