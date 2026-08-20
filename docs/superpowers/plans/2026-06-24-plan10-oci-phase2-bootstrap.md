# Plan 10 — OCI Phase 2 직행 부트스트랩 (2026-06-24)

> **Status**: ✅ 실행 완료 (2026-08-20) — 라이브 `https://kubeport.enzo.kr`. 이 문서(T1~T9)에 더해 **실제 k8s 배포 활성화**(k3s Google OIDC 신뢰 + iptables pod/service CIDR + RBAC + 클러스터 등록)가 추가로 수행됨. 운영·재현·롤백은 [docs/oci-prod-runbook.md](../../oci-prod-runbook.md) 와 [deploy/oci/README.md §7](../../../deploy/oci/README.md) 참조.
> **번호 의미 변경**: CLAUDE.md 표의 Plan 10 자리는 원래 **"GCP Phase 1 부트스트랩"** 이었으나, 2026-06-24 OCI A1 capacity 가 잡히면서 ADR 0003 §"즉시 OCI A1 가 잡히면 Phase 1 을 건너뛰고 Phase 2 로 직행" 분기로 전환. 본 플랜은 그 직행 경로를 실행한다. GCP 부트스트랩은 더 이상 필요 없으므로 archive 처리.

## 동기

ADR 0003 의 3-Phase 결정 트리에서 가장 좋은 시나리오 (Phase 2 직행) 가 실현됨:

- 2026-06-17~19 사이 [oci-a1-capacity-poll workflow](../../.github/workflows/oci-a1-capacity-poll.yml) 가 30분 간격으로 42회 시도
- 같은 기간 또는 그 직후 OCI 콘솔에서 수동으로 `kubeport` 인스턴스 (VM.Standard.A1.Flex, 4 OCPU / 24GB) 확보
- 워크플로의 `Check if instance already exists` 가 이를 감지 → `Disable workflow if instance exists` 가 폴링 자동 중단

다음 차단점은 이 인스턴스 위에 **kubeport 서비스를 실제로 띄우는 것**. Plan 9 가 chart 를 만들었고, kind smoke 까지 통과했지만 실서버에서의 첫 `helm install` 은 아직.

GCP Phase 1 부트스트랩이 필요 없어졌으므로 (= OCI 가 이미 잡혀서 90일 시한 카운트다운이 없음), 본 플랜은:
1. OCI VM 부트스트랩 (k3s + cert-manager + iptables/Security List)
2. Phase 2 용 values 파일 (`values-oci-phase2.yaml`)
3. 첫 `helm install` + Google OAuth 연동
4. 도메인 (Godaddy) + DNS A 레코드
5. 백업/모니터링 (idle reclaim 회피 ping, Boot Volume backup policy, `pg_dump` daily)

## 범위 (Scope)

**IN**:

- `deploy/helm/kubeport/values-oci-phase2.yaml` — Phase 2 환경별 values (k3s + traefik + local-path + Let's Encrypt)
- `deploy/oci/bootstrap.sh` — VM 위에서 한 번에 돌리는 시스템 부트스트랩
  - OS 방화벽 (`iptables`) 80/443 인그레스 열기 + persist
  - k3s install (single-node, embedded etcd)
  - cert-manager + Let's Encrypt ClusterIssuer
  - kubectl / helm CLI 설치
  - (옵션) `pg_dump` 일일 cron + Cloudflare R2 또는 외부 S3 호환 스토리지 업로드
- `deploy/oci/helm-install.sh` — Secret 값 받아서 첫 `helm install` 실행 (사용자가 ENV 채움)
- Google OAuth (OIDC) client 설정 가이드 (README 한 페이지)
- Godaddy DNS A 레코드 절차 (gcp/cloudflare 없이 Godaddy native — TTL 600s default)
- 외부 health ping 셋업 — UptimeRobot 무료 또는 GitHub Actions schedule (idle reclaim 회피)
- OCI Boot Volume backup policy 활성화 (Bronze — 주간, 4주 보존)
- CLAUDE.md 플랜 표 업데이트 (Plan 10 새 정의 반영, GCP 언급 제거)

**OUT (= 후속 또는 별도)**:

- **다중 클러스터 / HA / leader election** — Plan 12 (deferred)
- **ArgoCD GitOps** — 초기 CD 는 GHA → ssh → `helm upgrade` (ADR 0003 §공통 스택)
- **dex 자가호스팅** — Google OAuth 가 잘 동작하면 영구 불필요. 회사 LDAP 등 필요해질 때 별도 플랜
- **e2e 확장** — Plan 11
- **OCI Object Storage `pg_dump` upload** — 첫 helm install 직후가 아니라 운영 일주일 후 별도 task. 초기엔 local PVC snapshot 으로 충분 (boot volume backup policy 가 PVC 도 같이 잡음)
- **Phase 3 (Hetzner) 이전 절차** — OCI 가 정지/리클레임될 때 별도 runbook. 본 플랜 범위 밖

## 의존성 / 작업 환경

- **인프라 전제 (사용자 확인 필요)**:
  - OCI 인스턴스 `kubeport` 가 RUNNING, Ubuntu 24.04 ARM, 4 OCPU / 24GB
  - Public IP 가 안정적 (OCI 콘솔에서 ephemeral → reserved 로 전환 권장 — Always Free 한도 내)
  - Security List inbound: 80, 443, 22 (SSH 는 가능하면 본인 IP 만 허용)
  - SSH 키 페어 (`~/.ssh/oci_kuberport`) 가 로컬에 있음
  - Godaddy 에 사용할 도메인 (예: `kubeport.shyuni.dev`)
- **Google Cloud Console**:
  - OAuth 2.0 Client ID (Web application) 생성 — 별도 GCP 프로젝트 필요 없음, 무료
  - Authorized redirect URI: `https://<host>/api/auth/callback`
- **로컬 도구**: `ssh`, `helm` (≥ v3.14), `kubectl` (선택 — VM 안에서 다 됨)
- 별도 브랜치 `feat/plan10-oci-phase2`, 워크트리 권장. 추정 공수 1.5–2 영업일 (`deploy/` 파일들 + 실서버 부트스트랩 + DNS + OIDC + 검증).

## 환경변수 / Secret 컨트랙트

Plan 9 와 동일. chart 가 wire 하는 변수는 [Plan 9 §환경변수 컨트랙트](2026-04-29-plan9-helm-chart.md#환경변수-컨트랙트-현재-main-기준) 참조. 본 플랜이 추가로 결정해야 할 값들:

| 변수 | 값 | 출처 |
|---|---|---|
| `host` | `<사용자 도메인>` | values-oci-phase2.yaml + `--set host=...` |
| `oidc.issuer` | `https://accounts.google.com` | values |
| `oidc.clientId` | Google Cloud Console 의 OAuth Client ID | `--set oidc.clientId=...` |
| `auth.oidcClientSecret` | Google Cloud Console 의 OAuth Client Secret | `--set auth.oidcClientSecret=...` |
| `auth.appEncryptionKeyB64` | `openssl rand -base64 32` | install 시 1회 생성 + 보관 |
| `postgres.password` | `openssl rand -hex 24` | install 시 1회 생성 + 보관 |

**보관 위치**: 1Password / Bitwarden 같은 password manager 의 "kubeport prod" entry. **git / Slack / Notion 평문 금지.**

## 작업 순서 (TDD 흐름)

각 태스크: **검증 가능한 상태** → 작업 → **검증 통과**.

### T1. `values-oci-phase2.yaml` + helm template 통과

- `values-gcp-phase1.yaml` 을 출발점으로 복사 후 Phase 2 차이만 반영 (사실상 host placeholder, comments, resource 약간 키움)
- 검증: `helm template kubeport deploy/helm/kubeport -f deploy/helm/kubeport/values-oci-phase2.yaml --set host=test.example --set oidc.clientId=t --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) --set auth.oidcClientSecret=t --set postgres.password=t` 가 0 종료

### T2. `deploy/oci/bootstrap.sh` — VM 위 시스템 부트스트랩

- 입력: `BOOTSTRAP_EMAIL=<letsencrypt 알림 이메일>` env
- 단계:
  1. `iptables -I INPUT 6 -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT` + 443 + persist (`netfilter-persistent save`)
  2. k3s 설치 — `curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644 --disable=servicelb` (servicelb 끄는 이유: A1 의 80/443 은 traefik 이 hostPort 로 잡음, klipper-lb 와 충돌 회피)
  3. helm 설치 — `curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash`
  4. cert-manager 설치 — `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.1/cert-manager.yaml` + `kubectl wait`
  5. ClusterIssuer (Let's Encrypt prod) 생성 — `BOOTSTRAP_EMAIL` 사용
- 검증: 스크립트 끝나면 `kubectl get pods -A` 에서 cert-manager 3개 + traefik + coredns 가 Ready, `kubectl get clusterissuer letsencrypt-prod` 가 Ready=True

### T3. Godaddy DNS A 레코드 → 인스턴스 Public IP

- 사용자가 Godaddy 콘솔에서 수동 (API 토큰 가지고 있으면 `curl` 한 줄로도 가능 — 본 플랜은 콘솔 가정)
- 검증: `dig +short <host>` 가 인스턴스 Public IP 반환 (TTL 600s, 2~5분 대기)

### T4. Google OAuth Client 생성

- Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application
- Authorized redirect URI: `https://<host>/api/auth/callback`
- Authorized JavaScript origin: `https://<host>`
- Client ID + Secret 을 password manager 에 저장
- 검증: 구글 콘솔에서 client 가 보임

### T5. 첫 `helm install` + cert 발급 대기

- `deploy/oci/helm-install.sh` 또는 인라인 명령 (README 에 명시):
  ```bash
  helm install kubeport deploy/helm/kubeport \
    -f deploy/helm/kubeport/values-oci-phase2.yaml \
    --namespace kubeport --create-namespace \
    --set host=<host> \
    --set oidc.clientId=<google-client-id> \
    --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
    --set auth.oidcClientSecret=<google-client-secret> \
    --set postgres.password=$(openssl rand -hex 24)
  ```
- 검증:
  - `kubectl get pods -n kubeport -w` 모두 Running (backend, frontend, postgres-0)
  - `kubectl describe certificate -n kubeport` Ready=True (Let's Encrypt rate limit 신경 — 첫 시도가 잘못되면 staging issuer 로 전환 후 다시 prod)
  - 브라우저에서 `https://<host>` 가 200 + 인증서 valid

### T6. 첫 사용자 (= 본인) 로그인 + 카탈로그 빈 상태 확인

- `/login` → Google OAuth flow → 콜백 후 `/catalog` 도달
- 카탈로그 비어있는 상태 (템플릿 0개) 가 정상 렌더되는지 — Plan 1 ~ 4 가 만든 UI 가 빈 상태 처리 잘 되는지 한 번 더 확인
- 검증: 로그인 + `/catalog` 200 + 빈 상태 메시지 보임

### T7. 외부 health ping 셋업 (idle reclaim 회피)

- 옵션 A: UptimeRobot 무료 — 5분 간격 HTTP monitor → `https://<host>/healthz` (frontend 의 healthcheck path)
- 옵션 B: GitHub Actions schedule `*/5 * * * *` 로 `curl -sf https://<host>/healthz` 호출
- 둘 다 단순. **옵션 A 권장** (별도 회원가입 1회, 운영 부담 0)
- 검증: 1시간 뒤 UptimeRobot 대시보드에서 200 응답 100%, OCI 콘솔에서 CPU 모니터 그래프 baseline 이 0 이 아님

### T8. OCI Boot Volume backup policy 활성화

- OCI 콘솔 → Compute → Instances → `kubeport` → 좌측 Resources 패널 → Boot volume 클릭 → Backup policy → Edit → Bronze (주간, 4주 보존)
- 검증: Boot volume 페이지의 Backup policy 가 `bronze` 로 표시
- (선택) 첫 backup 이 다음 주 같은 시간에 생성되는지 일주일 뒤 확인

### T9. CLAUDE.md 플랜 표 업데이트

- Plan 10 행: "GCP Phase 1 부트스트랩" → "OCI Phase 2 직행 부트스트랩 + Godaddy DNS + Google OAuth"
- 상태: ⏳ planned → 🔨 진행 중 (T1 시작 시) → ✅ merged (PR 머지 시)
- ADR 0003 §"실행 체크리스트" 의 Phase 1 모든 항목에 ~~취소선~~ + 메모 "OCI 직행으로 건너뜀 (Plan 10)"

## 작업 환경 / 보안 주의

- **Public IP 가 노출된 후엔 SSH 키 회전 강력 권장**. ssh keys 가 OCI capacity 폴링 GHA secret 으로 업로드되어 있음 — kubeport 가입자가 본인 외에 늘어나면 별도 SSH key 로 분리.
- **APP_ENCRYPTION_KEY_B64 는 install 시 1회 생성 후 분실 금지**. 분실 시 DB 의 암호화된 컬럼 복호화 불가 → 사실상 전체 재구축.
- **Google OAuth client secret 은 commit 금지**. `--set` 으로만 주입.
- **`helm uninstall` 은 PVC 를 삭제하지 않음** — chart README §Uninstall 에 명시되어 있음. 의도된 안전망.

## 운영 체크리스트 (post-install, 첫 주)

- [ ] UptimeRobot CPU 그래프 정상 baseline 확인 (idle reclaim 위험 없음)
- [ ] Let's Encrypt 인증서 만료일 = 90일 + cert-manager 자동 갱신 동작 확인 (renew_before 30일)
- [ ] Postgres 데이터 양 증가 추세 (PVC 10Gi 한도 대비)
- [ ] OCI 콘솔 → Resource Management → Limits and Usage 에서 Always Free 한도 잘 안 넘는지 (특히 outbound transfer 월 10TB)
- [ ] 첫 동료에게 URL 공유 + 피드백 받기

## 영향 받는 문서

- `CLAUDE.md` — 플랜 표의 Plan 10 행 갱신 (T9)
- `docs/decisions/0003-hosting-oci-always-free.md` — Phase 1 체크리스트에 "OCI 직행으로 건너뜀" 메모
- `deploy/helm/kubeport/values-gcp-phase1.yaml` — 본 PR 에서는 유지 (archive 가치 + 후속 Hetzner 이전 시 참조 가능). 후속 cleanup PR 에서 삭제 검토.
- `deploy/helm/kubeport/README.md` — Quick install 섹션에 Phase 2 (OCI) 변형 추가
