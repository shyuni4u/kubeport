# ADR 0001: Frontend 배포를 Vercel 대신 Helm chart 내 k8s Pod로

| | |
|---|---|
| 날짜 | 2026-04-16 |
| 상태 | Accepted |
| 대체 대상 | 초기 디자인 스펙 v0.1의 "Frontend 배포: Vercel" 결정 |

## Context

브레인스토밍 시점엔 Next.js 프론트를 Vercel에 배포하기로 했다. Next.js 네이티브 플랫폼이고, PR preview deployment 같은 편의 기능도 공짜로 딸려오며, 내부 툴 수준의 트래픽에선 비용이 거의 0이라는 근거였다.

그러나 이후 논의에서 **self-hosted 설치 경험**이 우선 순위라는 점이 명확해졌다. kubeport는 "고객 k8s 클러스터에 설치해서 쓰는 포털" 이 주된 배포 시나리오인데, Vercel 모델에서는:

- 프론트는 Vercel, 백엔드는 고객 k8s 클러스터 → 배포 경로가 두 레인으로 쪼개짐
- 고객에게 "Vercel 계정 만들고 Git 연동하고 환경변수 입력하세요" 를 요구해야 함
- `helm install kubeport` 한 번으로 끝나는 단일 설치 경험이 불가능

즉 **편의성(Vercel)** 과 **통합 설치(Helm)** 가 충돌하는데, 제품 목적상 후자가 더 중요하다.

## Decision

프론트엔드도 k8s Pod로 배포한다. 구체적으로:

- Next.js를 `output: 'standalone'` 모드로 빌드하여 자체 포함된 Node 서버 이미지를 만든다.
- backend와 **같은 Helm chart** 내에 별도 `Deployment` + `Service` 로 포함시킨다.
- 단일 `Ingress` 에서 path 기반 라우팅: `/api/*` → backend Service, 그 외 → frontend Service.
- 결과: `helm install kubeport` 한 번으로 프론트 + 백엔드 + (옵션) embedded Postgres까지 전체 설치 완료.

**명시적으로 유지되는 것** (이 결정과 별개):
- BFF 패턴: Browser → Next.js Route Handler → Go API → k8s API
- OIDC 토큰을 httpOnly 쿠키에 격리, 브라우저 JS 접근 불가
- `openid-client` + `iron-session` 스택
- 모든 비즈니스 로직은 Go 백엔드

## Consequences

### 긍정적
- `helm install kubeport` 한 번으로 전체 설치 완료. 고객 온보딩 마찰 제거.
- 프론트-백 간 통신이 클러스터 내부 Service DNS (`http://kubeport-backend:8080`) 로 이뤄져 CORS / 도메인 설정 불필요.
- 단일 origin이라 쿠키 scope, CSP 등이 단순해진다.
- 사내망에서만 운영하려는 팀에 자연스러움 (public internet 경유 없음).
- 버전 관리가 단일. 프론트 v1.2 / 백엔드 v1.1 조합이 chart 태그로 고정됨.

### 부정적
- Vercel의 **PR별 preview deployment** 를 잃음 → MVP에선 로컬 docker-compose 또는 staging 클러스터로 대체. 장기적으론 자체 preview 환경 스크립트가 필요할 수 있음.
- Next.js 이미지 빌드/푸시 파이프라인을 직접 관리해야 함 (Dockerfile, CI job, 이미지 레지스트리).
- Vercel Edge 캐시/SSR 콜드 스타트 최적화를 위임할 수 없음 → 내부 툴 트래픽 규모에서 체감 영향은 미미할 것으로 판단.
- SaaS 모델로 피벗할 경우 이 결정은 재검토 대상이 된다.

### 중립
- 개발 루프는 동일: `pnpm dev` 로 로컬 Next.js를 띄우고 Go 백엔드를 별도로 실행.
- 기존 `frontend/` 레이아웃, 의존성 (`openid-client`, `iron-session`, `pg` 등) 전부 그대로.

## 영향 받는 문서

- `CLAUDE.md` — 기술 스택 표의 Frontend 배포 행
- `docs/brainstorming-summary.md` — 기술 스택 표 + 선택 근거 문단
- `docs/superpowers/specs/2026-04-16-initial-design.md` — 4.1 아키텍처, 5.4 배포, 7.1 다이어그램, 11.1~11.2 배포 모델, 상단 버전 (v0.1 → v0.2)
- `docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md` — Architecture 문장, Task 15의 Next.js 설정
- `README.md` — Architecture at a glance
- `.gitignore` — `frontend/.vercel/` 제거

## 연기된 작업 (이 ADR 범위 밖)

- 실제 프론트 Dockerfile 작성 및 Helm chart 에 Deployment/Service 리소스 추가.
- 이미지 레지스트리 + CI 파이프라인 구성.
- 위 항목은 별도 배포 plan (MVP-3 "User observability + self-hosting" 또는 전용 "Integrated deployment" plan) 에서 다룬다.
