# OCI Phase 2 — kubeport 부트스트랩 절차

ADR 0003 §"Phase 2 — Target (OCI Always Free A1.Flex)" 실행 가이드. Plan 10 의 사용자용 부분.

## 사전 준비

- [ ] OCI VM 확보: `VM.Standard.A1.Flex`, 4 OCPU / 24 GB, Ubuntu 24.04 ARM, Public IP 안정 (reserved 권장)
- [ ] OCI Security List inbound: 80, 443, 22 허용 (SSH 는 본인 IP 만 권장)
- [ ] SSH 키 (`~/.ssh/oci_kuberport`) 로 `ubuntu@<public-ip>` 접속 가능
- [ ] 도메인 보유 (예: Godaddy `<host>.example`)
- [ ] Google Cloud Console 접근 (OAuth client 발급용)

## 1. VM 시스템 부트스트랩

로컬에서:

```bash
scp -i ~/.ssh/oci_kuberport deploy/oci/bootstrap.sh ubuntu@<public-ip>:~
ssh -i ~/.ssh/oci_kuberport ubuntu@<public-ip>
sudo BOOTSTRAP_EMAIL=you@example.com bash bootstrap.sh
```

이게 처리하는 것:
- iptables 80/443 열기 + persist
- k3s single-node 설치
- helm CLI
- cert-manager + Let's Encrypt ClusterIssuer (`letsencrypt-prod`)

스크립트는 idempotent — 다시 돌려도 안전.

## 2. Godaddy DNS A 레코드

Godaddy 콘솔 → My Products → DNS → 해당 도메인 → DNS Records:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `kubeport` (또는 원하는 sub) | `<vm-public-ip>` | 600 (10분) |

검증 (로컬에서):

```bash
dig +short kubeport.example.com
# → <vm-public-ip>
```

전파에 2~5분.

## 3. Google OAuth Client 발급

1. https://console.cloud.google.com/apis/credentials → 별도 GCP 프로젝트 1개 만들기 (무료, 청구 불필요)
2. **OAuth consent screen** 먼저 셋업:
   - User type: External
   - App name: `kubeport`
   - User support email: 본인
   - Authorized domains: 사용할 도메인 추가 (예: `example.com`)
   - Test users: 본인 + 동료들 이메일 추가 (publish 안 해도 100명 한도 내 동작)
3. **Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `kubeport-prod`
   - Authorized JavaScript origins: `https://<host>`
   - Authorized redirect URIs: `https://<host>/api/auth/callback`
4. 발급된 **Client ID** + **Client secret** 을 password manager 에 저장. **절대 git/Slack/Notion 평문 금지.**

## 4. 첫 `helm install`

VM 안에서 (`ssh ubuntu@<public-ip>`). 먼저 리포 클론 (또는 chart 만 scp):

```bash
git clone https://github.com/shyuni4u/kubeport.git
cd kubeport
```

값 생성 + install:

```bash
# 한 번 생성하고 password manager 에 저장 — 절대 분실 금지
ENC_KEY=$(openssl rand -base64 32)
PG_PASS=$(openssl rand -hex 24)

HOST=kubeport.example.com               # 사용한 도메인
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

helm install kubeport deploy/helm/kubeport \
  -f deploy/helm/kubeport/values-oci-phase2.yaml \
  --namespace kubeport --create-namespace \
  --set host="$HOST" \
  --set oidc.clientId="$GOOGLE_CLIENT_ID" \
  --set oidc.audience="$GOOGLE_CLIENT_ID" \
  --set auth.appEncryptionKeyB64="$ENC_KEY" \
  --set auth.oidcClientSecret="$GOOGLE_CLIENT_SECRET" \
  --set postgres.password="$PG_PASS" \
  --set-string auth.devAdminEmails="you@gmail.com"
```

> **Google OIDC 특이사항 (실서버에서 걸린 함정)**
> - `oidc.audience` 는 반드시 **Google Client ID** 로 둔다. Google `id_token` 의 `aud` 는
>   client_id 이고, 백엔드 verifier 가 `aud == OIDC_AUDIENCE` 를 강제하므로 기본값
>   `kubeport` 로 두면 모든 로그인이 토큰 검증에서 튕긴다.
> - 로그인 scope 기본값은 `openid email profile` (chart `oidc.scopes` 로 override).
>   Google 은 `groups` scope 를 `invalid_scope` 로 거부한다 — Dex/Keycloak 처럼 그룹을
>   주는 IdP 에서만 `--set oidc.scopes="openid email profile groups"` 로 다시 켠다.
> - Google 은 groups 클레임을 주지 않으므로, 첫 관리자는 `auth.devAdminEmails` (콤마 구분,
>   `--set-string` + 콤마 이스케이프) 로 부트스트랩한다. 로그인 이메일이 일치하면 in-app
>   `kubeport-admin` 부여. 데모/부트스트랩 용도.
> - **OCI Security List inbound 80/443** 이 열려 있어야 한다 (OS `iptables` 와 별개인
>   클라우드단 방화벽). 안 열면 Let's Encrypt HTTP-01 챌린지부터 실패한다.

진행 상황 모니터링:

```bash
kubectl get pods -n kubeport -w
# postgres-0, kubeport-backend-..., kubeport-frontend-... 모두 Running 까지 5~10분
```

인증서 발급 (Let's Encrypt HTTP-01 challenge):

```bash
kubectl get certificate -n kubeport -w
# READY=True 가 되면 발급 완료 (2~5분)

# 디버깅이 필요하면:
kubectl describe certificate -n kubeport
kubectl describe order -n kubeport
kubectl describe challenge -n kubeport
```

DNS 가 전파 안 됐거나 80번 포트 차단되어 있으면 challenge 가 실패함. 그 경우 DNS dig + `curl -v http://<host>` 부터 확인.

## 5. 첫 로그인 확인

브라우저에서 `https://<host>` → Google OAuth → `/catalog` 도달 + 빈 상태 메시지. 끝.

## 6. 운영 셋업 (첫 주 내)

### 6.1. 외부 health ping (idle reclaim 회피)

OCI Always Free 정책상 7일간 CPU 95p < 20% AND network < 20% AND memory < 20% 셋 모두 충족하면 인스턴스가 자동 종료 대상. 외부에서 주기적 ping 으로 CPU/network 를 살린다.

**옵션 A: UptimeRobot 무료**
- https://uptimerobot.com 회원가입
- New monitor → HTTP(s) → URL: `https://<host>` (또는 backend `/healthz` 노출되면 그쪽)
- Interval: 5분 (무료 한도 안)

**옵션 B: GitHub Actions schedule**
이 리포 안에 `.github/workflows/uptime-ping.yml` 추가 (별도 PR — 본 가이드 범위 밖).

### 6.2. Boot Volume backup policy

OCI 콘솔 → Compute → Instances → `kubeport` → 좌측 Resources → **Boot volume** 클릭 → **Backup policy** → Edit → **Bronze** (주간, 4주 보존, Always Free 한도 내).

이게 boot volume 뿐 아니라 local-path PVC 가 거기 안에 있으므로 Postgres 데이터도 같이 보존.

### 6.3. (선택) `pg_dump` 일일 cron + 외부 복제

본 플랜 범위 밖. 일주일 운영 후 데이터 양 보고 결정. 옵션:
- VM 안 cron + Cloudflare R2 (S3 호환) 무료 10 GB
- 또는 OCI Object Storage Always Free 10 GB + Cloudflare R2 이중 복제 (OCI 계정 정지 헤지)

## 7. 실제 배포 활성화 (k3s ↔ Google OIDC ↔ RBAC ↔ 클러스터 등록)

여기까지(§1~6)는 **앱이 뜨고 로그인**되는 상태다. 앱이 **실제로 k8s 리소스를 배포**하려면
추가로 4가지가 필요하다 — backend 가 사용자 Google 토큰을 k8s API 로 포워딩하므로, k3s 가
그 토큰을 인증으로 받아들이고 사용자가 RBAC 권한을 가져야 한다.

### 7.1. k3s 가 Google 토큰을 인증으로 수용

k8s `--oidc-*` 플래그는 `--authentication-config` 와 **동시에 쓸 수 없다.** Dex 데모 IdP(§7.6)를
나중에 추가할 것을 감안해 처음부터 구조화된 `AuthenticationConfiguration` 형식을 쓴다. `bootstrap.sh`
가 `BOOTSTRAP_OIDC_CLIENT_ID` 를 주면 이 형식으로 자동 작성한다(Step 2 코드 참조). 수동으로 하려면:

```bash
sudo tee /etc/rancher/k3s/auth.yaml >/dev/null <<'EOF'
apiVersion: apiserver.config.k8s.io/v1
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://accounts.google.com
      audiences: ["<GOOGLE_CLIENT_ID>"]
    claimMappings:
      username: { claim: email, prefix: "" }
EOF
sudo tee /etc/rancher/k3s/config.yaml >/dev/null <<'EOF'
kube-apiserver-arg:
  - "authentication-config=/etc/rancher/k3s/auth.yaml"
EOF
sudo systemctl restart k3s
# 검증 (반드시): sudo k3s kubectl get --raw=/readyz  →  "ok"
```

- `apiVersion` 은 k8s ≥ 1.34 면 `apiserver.config.k8s.io/v1`(GA), 1.30–1.33 이면
  `apiserver.config.k8s.io/v1beta1`(beta). `bootstrap.sh` 는 `BOOTSTRAP_AUTH_API` 로 오버라이드 가능
  (기본값 `v1`).
- ⚠️ **값은 반드시 큰따옴표로.** YAML 리스트 항목 값 끝에 콜론이 있으면 맵으로 잘못 파싱돼 k3s 가
  `Error: unknown flag: --[{...}]` 로 죽는다.
- ⚠️ `audiences` 는 Google Client ID (backend `oidc.audience` 와 동일 값).
- `claimMappings.username.prefix: ""` = 접두어 없음 → k8s username 이 raw 이메일이 된다(`--oidc-*`
  플래그 시절의 `oidc-username-prefix=-` 와 동등).
- **롤백** (apiserver 가 crash-loop 하면): `sudo rm -f /etc/rancher/k3s/config.yaml && sudo systemctl restart k3s`
  (또는 `k3s-auth-config.sh` 로 세팅한 뒤라면 `ROLLBACK=1 sudo bash deploy/oci/k3s-auth-config.sh`).
  재기동 명령은 **롤백까지 한 번에 묶어** 실행할 것(컨트롤플레인 ~30초 블립, 앱 파드는 유지).

### 7.2. pod → apiserver 방화벽 (bootstrap 이 처리 — 배경)

OCI Ubuntu 이미지는 iptables 끝단에서 전부 REJECT 한다. k3s pod(`10.42.0.0/16`)/service
(`10.43.0.0/16`) CIDR 을 안 열면 **pod → apiserver(6443) 가 막혀 배포가 전부 조용히 실패**한다.
**`bootstrap.sh` 가 이제 이 CIDR ACCEPT 규칙을 자동으로 넣는다** (Step 1). 아래는 배경/검증용.

이 픽스 이전에 부트스트랩된 인스턴스라면 수동으로:

```bash
sudo iptables -I INPUT 1 -s 10.42.0.0/16 -j ACCEPT   # pod CIDR
sudo iptables -I INPUT 1 -s 10.43.0.0/16 -j ACCEPT   # service CIDR
sudo netfilter-persistent save
```

검증: 파드에서 apiserver 로 `curl` → **401**(연결 OK, 인증만 거부) 이면 정상. **000** 이면 아직 막힘.

> §7.1 의 k3s OIDC config 도 `bootstrap.sh` 에 `BOOTSTRAP_OIDC_CLIENT_ID` env 를 주면
> 설치 전에 자동 작성된다(첫 기동부터 적용, 재기동 불필요).

### 7.3. RBAC 바인딩

오너(운영자) Google 이메일만 cluster-admin 으로 바인딩한다. **데모 사용자는 여기서 수동으로
바인딩하지 않는다** — Helm chart(`demo.enabled=true`)가 `dex:demo-admin@demo.kubeport` /
`dex:demo-user@demo.kubeport` 를 `demo` 네임스페이스 스코프 Role 에 자동으로 바인딩한다
(§7.6 참조).

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl create clusterrolebinding kubeport-owner-admin \
  --clusterrole=cluster-admin --user="<오너 Google 이메일>"
```

### 7.4. 클러스터를 배포 대상으로 등록

`POST /v1/clusters`(admin 전용). in-cluster 값으로 등록한다:

| 필드 | 값 |
|---|---|
| `api_url` | `https://kubernetes.default.svc` |
| `ca_bundle` | k3s 서버 CA (`/var/lib/rancher/k3s/server/tls/server-ca.crt` 내용) |
| `oidc_issuer_url` | `https://accounts.google.com` |
| `default_namespace` | `default` |

admin UI 에 클러스터 등록 화면이 아직 없으므로, admin 토큰으로 API 호출하거나 DB 에 직접 insert
한다(인프라 config, PII 아님). 등록 후 로그인하면 좌측하단 클러스터 드롭다운에 나타난다.

### 7.5. 검증

로그인(admin 이메일) → `/templates` 에서 템플릿 작성·게시 → 카탈로그에서 그 템플릿을 폼으로
배포(클러스터 선택) → 릴리스 상세의 로그/인스턴스에 **실제 파드**가 보이면 성공.

> 운영 중 이 값들을 만질 때는 [docs/oci-prod-runbook.md](../../docs/oci-prod-runbook.md) 참조.

### 7.6. Demo IdP (Dex) 신뢰 추가

§7.1 은 Google 만 신뢰한다. 데모용 Dex IdP(비밀번호 로그인, `demo-admin@demo.kubeport` /
`demo-user@demo.kubeport`)도 신뢰하려면 `deploy/oci/k3s-auth-config.sh` 를 VM 에서 실행한다.

**사전 준비** (순서 중요 — Dex 가 먼저 살아 있어야 한다):
- DNS `dex.kubeport.enzo.kr` → VM 공인 IP (A 레코드 등록·전파 완료).
- `helm upgrade` 로 `dex.enabled=true` / `demo.enabled=true` 배포 완료.
  `values-oci-phase2.yaml` 은 둘 다 `false` 이므로 **최초 1회는 아래 `--set` 목록을 반드시 명시**한다
  (이후 `--reuse-values` 가 유지):

  ```bash
  DEMO_PW=$(openssl rand -base64 9 | tr -d '/+=' | cut -c1-10)   # 사람이 칠 수 있게 짧게 — 공개되는 값
  DEX_SECRET=$(openssl rand -hex 24)                             # 비밀번호 관리자에 저장
  HASH=$(htpasswd -bnBC 10 "" "$DEMO_PW" | tr -d ':\n')
  helm upgrade kubeport deploy/helm/kubeport \
    -f deploy/helm/kubeport/values-oci-phase2.yaml \
    --namespace kubeport --reuse-values \
    --set dex.enabled=true --set dex.host=dex.kubeport.enzo.kr \
    --set dex.clientSecret="$DEX_SECRET" \
    --set "dex.staticPasswords[0].hash=$HASH" \
    --set "dex.staticPasswords[1].hash=$HASH" \
    --set demo.enabled=true \
    --set demo.passwordHint="$DEMO_PW" \
    --set demo.adminPassword="$DEMO_PW" \
    --set demo.userPassword="$DEMO_PW"
  ```

- Dex 인증서 발급 완료 (`kubectl get certificate -n kubeport` 에서 Dex cert `Ready=True`).
- 클러스터 **내부에서** Dex 에 닿는지 확인. backend 는 issuer discovery 를 lazy 하게 하므로
  Dex 가 안 뜨면 부팅이 죽지는 않지만 데모 로그인이 401 로 떨어진다:

  ```bash
  kubectl -n kubeport exec deploy/kubeport-backend -- \
    wget -qO- https://dex.kubeport.enzo.kr/.well-known/openid-configuration | head -c 200
  ```

**실행**:

```bash
ssh ubuntu@<public-ip>
sudo GOOGLE_CLIENT_ID=<google-client-id> bash deploy/oci/k3s-auth-config.sh
# 필요 시 오버라이드: DEX_ISSUER / DEX_CLIENT_ID / DEX_USERNAME_PREFIX
```

스크립트는 `/etc/rancher/k3s/auth.yaml` 에 Google + Dex 두 issuer 를 모두 쓰고, `config.yaml.bak` 을
남기고, k3s 를 재기동해 `/readyz` 를 확인하며, 실패 시 자동 롤백한다.

**검증** — Dex 토큰으로 로그인해 RBAC 스코프 확인:

```bash
TOKEN=$(curl -s -X POST https://dex.kubeport.enzo.kr/token -d grant_type=password -d client_id=kubeport-demo -d client_secret=$DEX_SECRET -d username=demo-user@demo.kubeport -d password=$DEMO_PW -d scope='openid email' | jq -r .id_token)
kubectl --token="$TOKEN" auth whoami          # → dex:demo-user@demo.kubeport
kubectl --token="$TOKEN" -n demo auth can-i create deployments   # yes
kubectl --token="$TOKEN" -n default auth can-i create deployments # no
```

데모 계정이 가드레일(quota/limitrange/networkpolicy)을 못 건드리는지도 확인:

```bash
kubectl auth can-i delete resourcequota --as=dex:demo-admin@demo.kubeport -n demo   # → no
```

**롤백**: `sudo ROLLBACK=1 bash deploy/oci/k3s-auth-config.sh` — `config.yaml.bak` 을 복원하고
재기동·검증까지 수행한다.

## Upgrade

이미지 태그 갱신 시:

```bash
helm upgrade kubeport deploy/helm/kubeport \
  -f deploy/helm/kubeport/values-oci-phase2.yaml \
  --namespace kubeport \
  --reuse-values \
  --set images.backend.tag=$NEW_SHA \
  --set images.frontend.tag=$NEW_SHA
```

`--reuse-values` 가 첫 install 의 secret 들을 유지 — 데모 모드(`dex.*`/`demo.*`) 도 마찬가지로,
§7.6 의 최초 `--set` 목록을 한 번만 주면 이후 업그레이드에서는 다시 줄 필요가 없다.
반대로 `--reuse-values` 없이 `-f values-oci-phase2.yaml` 만 쓰면 데모 모드가 **꺼진다**. backend Pod 의 `migrate` initContainer 가 매번 `atlas schema apply` 를 다시 돌리므로 schema 변경도 자동 반영.

## Troubleshooting

| 증상 | 원인 / 확인 |
|---|---|
| `kubectl get pods -n kubeport` 가 Pending | k3s 가 아직 Ready 아님. `sudo systemctl status k3s` |
| backend / frontend CrashLoop | `kubectl logs -n kubeport <pod>` — 대개 OIDC issuer 발견 실패 (DNS) 또는 DB connection (postgres-0 미준비) |
| Certificate stuck Issuing | `kubectl describe challenge -n kubeport` — 대부분 DNS 미전파 또는 80번 차단 (iptables 또는 OCI Security List) |
| 브라우저에서 `ERR_CERT_AUTHORITY_INVALID` | cert 가 staging issuer 로 발급된 경우. `letsencrypt-prod` 사용 확인 |
| Google OAuth `redirect_uri_mismatch` | console.cloud.google.com 의 Authorized redirect URI 가 정확히 `https://<host>/api/auth/callback` 인지 확인 (trailing slash 없음) |

## See also

- [Plan 10 — OCI Phase 2 직행 부트스트랩](../../docs/superpowers/plans/2026-06-24-plan10-oci-phase2-bootstrap.md)
- [ADR 0003 — Hosting decision tree](../../docs/decisions/0003-hosting-oci-always-free.md)
- [Helm chart README](../helm/kubeport/README.md)
