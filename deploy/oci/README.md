# OCI Phase 2 — kubeport 부트스트랩 절차

ADR 0003 §"Phase 2 — Target (OCI Always Free A1.Flex)" 실행 가이드. Plan 10 의 사용자용 부분.

## 사전 준비

- [ ] OCI VM 확보: `VM.Standard.A1.Flex`, 4 OCPU / 24 GB, Ubuntu 24.04 ARM, Public IP 안정 (reserved 권장)
- [ ] OCI Security List inbound: 80, 443, 22 허용 (SSH 는 본인 IP 만 권장)
- [ ] SSH 키 (`~/.ssh/oci_kuberport` — 초기 오타지만 실제 파일명이라 그대로 사용) 로 `ubuntu@<public-ip>` 접속 가능
      · 이 문서는 **키를 만드는 머신** 기준이라 홈 바로 아래다. 나중에 gpg 번들로 **복원한** 머신에서는
      `~/.ssh/kuberport-oci/oci_kuberport` 가 된다 — 둘 다 정상이며 통일하지 않는다
      ([runbook §1 "SSH 키 위치"](../../docs/oci-prod-runbook.md#ssh-키-위치--두-곳-다-정상이다-68))
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
- k3s single-node 설치 — **버전 고정**(`v1.36.3+k3s1`, 스크립트의 `K3S_PINNED`). k3s 가 Traefik 을 번들하므로
  고정하지 않으면 설치한 날에 따라 인그레스까지 달라진다(#194). 이미 깔린 k3s 는 바꾸지 않고, 고정 버전과 다르면
  경고만 한다. 복구 등으로 다른 버전이 필요하면 `BOOTSTRAP_K3S_VERSION=<버전>` (적용 시 로그에 표시).
  `v1.NN.P+k3sN` 형식의 **v1.30 이상**만 받고, upstream 지원이 끝난 마이너(스크립트의 `K3S_MIN_SUPPORTED_MINOR` 미만)는
  `BOOTSTRAP_K3S_ALLOW_EOL=1` 을 줄 때만 깐다 — 아니면 호스트를 건드리기 전에 거부한다. AuthenticationConfiguration 의
  apiVersion 은 apiserver 버전(이미 깔린 k3s 가 있으면 그 버전)에 맞춰 고른다. 재실행은 이미 있는
  `/etc/rancher/k3s/auth.yaml`·`config.yaml` 을 덮어쓰지 않는다 — `k3s-auth-config.sh` 가 넣은 Dex 신뢰가 지워지지 않게.
  대신 **k3s 가 실제로 읽을 설정이 bootstrap 이 쓸 설정과 같은지** 검사해, 어긋나면 호스트를 건드리기 전에 멈춘다 —
  `config.yaml` 은 `kube-apiserver-arg` 블록 리스트 하나에 활성 항목이 정확히 `authentication-config=/etc/rancher/k3s/auth.yaml`
  하나(주석 처리된 줄·`.bak` 경로·스칼라 형식은 불일치), `config.yaml.d/` 드롭인에 apiserver 인자 없음, `auth.yaml` 은 최상위가
  apiVersion·kind·jwt 뿐이고 apiVersion 이 맞으며, 요청한 issuer(`BOOTSTRAP_OIDC_ISSUER`) 항목의 Client ID audience·username
  claim(`BOOTSTRAP_OIDC_USERNAME_CLAIM`)·빈 prefix·그 밖의 매핑 없음. 다른 issuer(Dex) 항목은 비교하지 않고 보존한다.
  두 파일 모두 주석 줄과 줄끝 주석을 벗긴 뒤 **값**으로 비교한다(audiences 는 원소, 나머지는 따옴표를 뗀 값) — 주석 안의 값은
  판정에 쓰이지 않고, 그렇게 읽을 수 없는 형식(블록 리스트 audiences, 블록 맵 username 등)은 거부한다.
- **받아서 root 로 실행·적용하는 파일은 내용(sha256)으로 고정한다**(#221) — k3s `install.sh` 와 **k3s 바이너리**(핀한 버전
  태그, arm64/amd64), helm 릴리스 tarball(`HELM_VERSION`), cert-manager 매니페스트(`CERT_MANAGER_VERSION`). 호스트를 건드리기
  전(Step 0)에 받아 스크립트에 적힌 해시와 대조하고, **다르면 아무것도 설치하지 않고 멈춘다** — 예전 주소(get.k3s.io,
  get-helm-3@main)로 되돌아가지 않는다. 바이너리는 릴리스 안의 `sha256sum` 파일이 아니라 스크립트의 핀과 대조하므로, 릴리스
  자산을 둘 다 바꿔도 통과하지 못한다. 오버라이드한 k3s 버전은 이 파일에 해시가 없으므로 `BOOTSTRAP_K3S_INSTALL_SHA256` 과
  `BOOTSTRAP_K3S_BIN_SHA256` 을 같이 줘야 한다(이미 k3s 가 깔린 노드는 설치하지 않아 불필요). **범위 밖:** 컨테이너 이미지 —
  cert-manager 매니페스트와 k3s 번들(traefik·coredns 등)은 실행 시 이미지를 태그로 받는다.
- helm CLI (위 tarball)
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

**옵션 B: GitHub Actions schedule (이 리포에 이미 있음)**
`.github/workflows/uptime-ping.yml` 이 10분마다 `https://<host>` 를 ping 한다. 다른 도메인으로
포크했다면 그 파일의 URL 만 바꾸면 된다.

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
  `apiserver.config.k8s.io/v1beta1`(beta). `bootstrap.sh` 는 apiserver 버전(이미 깔린 k3s 가 있으면 그 버전)에
  맞춰 고른다. `BOOTSTRAP_AUTH_API` 로 덮을 수 있지만, 1.34 미만에 `v1` 을 주면 호스트를 건드리기 전에 거부한다.
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

> `name` 도 필수 필드다(위 표에 없음). 실행 가능한 curl·SQL 과 토큰 획득 방법은
> [docs/machine-clients.md §4](../../docs/machine-clients.md) 참조.
> **`ca_bundle` 을 비우면 백엔드가 TLS 검증 없이 그 클러스터에 접속하면서도 등록은 201 로 성공한다.**

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
  (이후 `--reuse-values` 가 유지). VM 에는 `htpasswd`(`apache2-utils`) 와 `jq` 가 필요하다:

  ```bash
  # 화면에 띄워 놓고 사람이 읽어 옮겨 적는 값이라 혼동 문자를 뺀다 (0 O 1 l I).
  # base64 는 l·I·1·O·0 을 그대로 뱉어서 못 쓴다 (#132). 32글자 × 10자 = 50비트.
  DEMO_PW=$(LC_ALL=C tr -dc '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' < /dev/urandom | head -c 10)
  DEX_SECRET=$(openssl rand -hex 24)                             # 비밀번호 관리자에 저장
  HASH=$(htpasswd -bnBC 10 "" "$DEMO_PW" | tr -d ':\n')
  # 자동 배포와 같은 락을 잡는다. 이미지 태그는 여기서 올리지 않는다 — 태그는 kubeport-deploy 만 올린다.
  flock -w 600 /run/lock/kubeport-deploy.lock \
  helm upgrade kubeport ~/kubeport-chart/kubeport \
    --namespace kubeport --reset-then-reuse-values \
    --set dex.enabled=true --set dex.host=dex.kubeport.enzo.kr \
    --set dex.clientSecret="$DEX_SECRET" \
    --set "dex.staticPasswords[0].email=demo-admin@demo.kubeport,dex.staticPasswords[0].username=demo-admin,dex.staticPasswords[0].userID=demo-admin-000,dex.staticPasswords[0].hash=$HASH" \
    --set "dex.staticPasswords[1].email=demo-user@demo.kubeport,dex.staticPasswords[1].username=demo-user,dex.staticPasswords[1].userID=demo-user-000,dex.staticPasswords[1].hash=$HASH" \
    --set demo.enabled=true \
    --set demo.passwordHint="$DEMO_PW" \
    --set demo.adminPassword="$DEMO_PW" \
    --set demo.userPassword="$DEMO_PW"
  ```

  **먼저 `kubeport-deploy status` 로 락이 `free` 인지 본다.** `HELD` 면 배포가 진행 중이니 끝날 때까지
  기다린다 — 위 `flock -w 600` 도 최대 10분 기다린 뒤 실패한다. 비밀번호 회전(이 명령의 재실행)이면
  [runbook §5 "데모 비밀번호 회전"](../../docs/oci-prod-runbook.md#데모-모드-운영-plan-13-2026-09-08-롤아웃-완료)
  0단계대로 자동 배포를 잠시 끈다. 이 명령은 Dex 를 재시작시키므로 끝나면 **`sudo systemctl restart k3s`** 까지 한다.

  ⚠️ 2026-09-08 실제 롤아웃에서 걸린 세 가지 (모두 위 명령에 반영됨):
  - **`-f values-oci-phase2.yaml` 을 같이 주면 안 된다.** 그 파일은 `host`·시크릿을 빈 값/플레이스홀더로
    갖고 있어 `--reuse-values` 로 유지된 값을 덮어쓴다 (`auth.appEncryptionKeyB64 is required` 로 실패).
    install 때 이미 적용된 비밀 아닌 설정은 릴리스 values 에 남아 있으므로 업그레이드엔 `--set` 만 준다.
  - **차트에 새 키가 생긴 업그레이드는 `--reset-then-reuse-values`** (Helm ≥ 3.14). `--reuse-values` 만 쓰면
    새 차트의 기본값(`demo.namespace`, `dex.image`, `demo.resetSchedule` …)이 전부 빈 값이 되어
    `Namespace ""` 같은 에러로 실패한다.
  - **`staticPasswords[N].hash` 만 `--set` 하면 email/username/userID 가 사라진다.** Helm 은 리스트를
    병합하지 않고 통째로 교체하므로 항목의 네 필드를 전부 준다. (증상: Dex 가 `Invalid username or password`.)

- Dex 인증서 발급 완료 (`kubectl get certificate -n kubeport` 에서 Dex cert `Ready=True`).
- 클러스터 **내부에서** Dex 에 닿는지 확인. backend 는 issuer discovery 를 lazy 하게 하므로
  Dex 가 안 뜨면 부팅이 죽지는 않지만 데모 로그인이 401 로 떨어진다:

  ```bash
  kubectl -n kubeport run dex-probe --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- \
    curl -s https://dex.kubeport.enzo.kr/.well-known/openid-configuration | head -c 200
  ```

  backend 파드에 `kubectl exec` 으로 확인하지 말 것 — 이미지가 distroless 라 셸도 `wget` 도 없어
  **항상** `failed to exec in container` 로 끝난다. 배경은
  [runbook §6](../../docs/oci-prod-runbook.md#6-운영--관측) "Go API 를 직접 찔러 보기".

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

## 자동 배포 설치 (GitHub Actions → VM)

main 머지 → build-images·CI(같은 sha 둘 다 성공) → `.github/workflows/deploy.yml` → VM 의 `kubeport-deploy` 로 라이브까지
자동으로 가게 하는 1회 설치. 동작·운영·실패 읽기는
[runbook §3](../../docs/oci-prod-runbook.md#3-재배포-이미지-갱신). 설계 원칙은 둘이다:

- **관리자 키를 GitHub 에 올리지 않는다.** 배포 전용 키를 새로 만들고, VM 이 그 키를
  `restrict,command="/usr/local/bin/kubeport-deploy --forced"` 로 묶는다. 이 키로 할 수 있는 일은 그
  스크립트가 받아 주는 `deploy <main sha>` 와 `status` 뿐이다(셸·포워딩·pty 없음). 그리고 **앞으로만** 간다 —
  지금 라이브 이미지보다 옛 커밋은 main 에 있어도 거절한다(#47·#101 같은 보안 수정 이전으로 되돌리지 못하게).
  롤백은 관리자 키로만 한다(아래 8).
- **배포 키도 `ubuntu` 계정에 둔다 — 전용 사용자를 만들지 않는 이유.** k3s kubeconfig 가 0644 라 노드의
  어떤 로컬 사용자든 cluster-admin 이고, single-node 에서 cluster-admin 은 곧 노드 root 다. 계정을 나눠도
  막히는 것이 없다. 방어의 핵심은 `restrict`(셸·포워딩 없음)와, 스크립트가 authorized_keys 의 명시 인자
  `--forced` 로만 배포 키 경로를 판정하는 것이다.
- **순서: 1~5 를 먼저, 6 은 첫 자동 배포 확인.** 1~5 가 끝나기 전의 main push 에서는 deploy 가 시크릿이 없어
  `Missing secret` 으로 실패할 뿐 해는 없다. 포크·자가호스팅 리포에서는 잡 자체가 건너뛰어진다.

아래 `$KEY` 는 **관리자** 키([runbook §1 "SSH 키 위치"](../../docs/oci-prod-runbook.md#ssh-키-위치--두-곳-다-정상이다-68)),
`$IP` 는 현재 공인 IP 다.

1. **배포 전용 키 생성** (로컬, 패스프레이즈 없음 — Actions 가 쓴다):

   ```bash
   ssh-keygen -t ed25519 -N '' -C kubeport-gha-deploy -f ~/.ssh/kubeport-gha-deploy
   ```

   개인키는 4단계에서 GitHub 시크릿으로 올린 뒤 로컬에서 지워도 된다(재발급이 더 간단하다).

2. **VM 에 스크립트 설치** — root 소유 0755. 배포 키를 쓰는 사용자(`ubuntu`)가 스크립트를 고칠 수 없게.
   **스크립트는 main 의 것을 쓴다** — 작업 중인 브랜치의 파일을 올리면 리뷰·머지되지 않은 코드가 배포 키의
   권한을 정한다. `git fetch origin main && git checkout origin/main -- deploy/oci/kubeport-deploy.sh` 로
   작업 트리에 꺼내거나, 아래처럼 `git show` 로 바로 파일을 만든다:

   ```bash
   git fetch origin main
   git show origin/main:deploy/oci/kubeport-deploy.sh > /tmp/kubeport-deploy.sh
   scp -i "$KEY" /tmp/kubeport-deploy.sh ubuntu@$IP:/tmp/kubeport-deploy.sh
   ssh -i "$KEY" ubuntu@$IP 'sudo install -o root -g root -m 0755 /tmp/kubeport-deploy.sh /usr/local/bin/kubeport-deploy \
     && rm /tmp/kubeport-deploy.sh \
     && sudo apt-get install -y jq curl util-linux \
     && helm version --short \
     && kubeport-deploy status'
   ```

   마지막 줄이 락 상태·`helm history`·이미지 태그를 찍으면 설치 완료. 스크립트가 필요로 하는 것:
   `helm`(3 또는 4), `kubectl`, `curl`, `jq`, `tar`, `flock`, `/etc/rancher/k3s/k3s.yaml` 읽기 권한(0644 —
   `bootstrap.sh` 기본), 노드에서 `api.github.com`·`codeload.github.com` 로의 아웃바운드.
   **main 의 스크립트가 바뀌면 이 단계를 다시 실행한다** — 자동으로 갱신되지 않는 것이 의도다.

3. **`authorized_keys` 에 제한된 한 줄 추가** — 형식 (`--forced` 까지가 command 다):

   ```
   restrict,command="/usr/local/bin/kubeport-deploy --forced" ssh-ed25519 AAAA...(공개키)... kubeport-gha-deploy
   ```

   ```bash
   ssh -i "$KEY" ubuntu@$IP \
     "umask 077; printf 'restrict,command=\"/usr/local/bin/kubeport-deploy --forced\" %s\n' '$(cat ~/.ssh/kubeport-gha-deploy.pub)' >> ~/.ssh/authorized_keys"
   ```

   `--forced` 가 빠진 줄(예전 형식)은 스크립트가 빈 요청으로 보고 **모든 요청을 거절한다**(exit 2,
   `rejected`) — 조용히 관리자 경로로 새지 않는다. 예전 줄을 넣었었다면 이 줄로 교체한다.

   검증 — 넷 다 기대대로여야 한다:

   ```bash
   DK=(-i ~/.ssh/kubeport-gha-deploy -o IdentitiesOnly=yes)
   ssh "${DK[@]}" ubuntu@$IP status        # → status 출력, exit 0
   ssh "${DK[@]}" ubuntu@$IP 'id'; echo $?  # → rejected request, 2
   ssh "${DK[@]}" -t ubuntu@$IP; echo $?    # → 셸 없이 rejected, 2
   # 되돌리기 거절: 리포의 첫 커밋은 main 에 있지만 라이브보다 옛것이다. 클러스터를 건드리기 전에 멈춘다.
   ssh "${DK[@]}" ubuntu@$IP "deploy $(git rev-list --max-parents=0 origin/main)"; echo $?
   #   → "rollback needs the admin key", KUBEPORT_DEPLOY_RESULT=refused-not-forward, 2
   ```

   `-o IdentitiesOnly=yes` 를 빼면 ssh-agent 의 관리자 키가 먼저 쓰여 **제한이 안 걸린 것처럼 보인다.**

4. **known_hosts 고정** — IP 는 ephemeral 이라 호스트 키를 시크릿으로 고정한다. keyscan 결과를 믿기 전에
   관리자 세션으로 본 지문과 대조:

   ```bash
   ssh-keyscan -t ed25519 "$IP" > /tmp/kubeport-known-hosts
   ssh-keygen -lf /tmp/kubeport-known-hosts
   ssh -i "$KEY" ubuntu@$IP 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'   # 두 SHA256 지문이 같아야 한다
   ```

5. **GitHub Environment `production` 과 environment 시크릿 3개** (리포 `shyuni4u/kubeport`). 리포 레벨
   시크릿이 아니라 environment 시크릿이다 — 배포 브랜치를 main 으로 제한해, 다른 브랜치에서 돈 워크플로는
   배포 키를 읽지 못한다. `deploy.yml` 의 잡이 `environment: production` 을 선언한다.

   ```bash
   # Environment 생성 + 배포 브랜치를 main 하나로 제한 (Settings → Environments 에서 해도 같다)
   gh api -X PUT repos/shyuni4u/kubeport/environments/production \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/shyuni4u/kubeport/environments/production/deployment-branch-policies \
     -f name=main -f type=branch

   gh secret set OCI_DEPLOY_SSH_KEY      --env production < ~/.ssh/kubeport-gha-deploy
   gh secret set OCI_DEPLOY_KNOWN_HOSTS  --env production < /tmp/kubeport-known-hosts
   gh secret set OCI_DEPLOY_HOST         --env production --body "$IP"
   gh secret list --env production        # 셋이 보여야 한다
   ```

   같은 이름을 예전에 리포 레벨로 올렸다면 지운다(`gh secret delete OCI_DEPLOY_SSH_KEY` 등) — 남겨 두면
   environment 제한 밖에서도 읽힌다.

6. **첫 자동 배포 확인.** 1~5 뒤의 첫 main push 에서 build-images 와 CI 가 둘 다 초록으로 끝나면 deploy 가 자동으로 돈다 —
   그 런이 첫 검증이다. Actions → deploy 에서 세 단계가 초록인지, 특히 마지막 `Wait for /api/healthz` 가
   `reports <sha7>` 로 끝나는지 본다. 기다릴 main push 가 없으면 7 의 dispatch 로 바로 확인한다.
   (`workflow_dispatch`·`workflow_run` 은 기본 브랜치의 워크플로 파일만 쓰므로, `deploy.yml` 이 main 에
   없는 동안에는 둘 다 돌지 않는다.)

7. **수동 dispatch 로 검증** (같은 sha 재배포 — 변경 없는 upgrade 라 파드는 그대로다):

   ```bash
   git fetch origin main
   gh workflow run deploy.yml -f sha="$(git rev-parse origin/main)"
   gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')"
   curl -s https://kubeport.enzo.kr/api/healthz | jq -r .version
   ```

8. **롤백 방법** — **관리자 키로만** 한다. 배포 키(=Actions dispatch)는 앞으로만 가므로 옛 sha 를
   주면 `refused-not-forward` 로 거절된다. 둘 중 위에서부터:
   - `gh workflow disable deploy.yml` 로 자동 배포를 먼저 멈춘다(안 그러면 다음 main 커밋이 다시 앞으로 간다).
     그다음 `ssh -i "$KEY" ubuntu@$IP kubeport-deploy deploy <이전 main 커밋 40자리>` — 이미지·템플릿이 함께
     되돌아가고, 락·main 검증·Dex 가드·자동 롤백을 그대로 탄다. 고친 커밋이 main 에 들어가면 `enable`.
     (롤백 뒤 dispatch 로 다시 앞으로 가는 것은 된다.)
   - 스크립트도 안 될 때: `ssh -i "$KEY" ubuntu@$IP "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; flock -w 600 /run/lock/kubeport-deploy.lock helm rollback kubeport <rev> -n kubeport"`.
   - DB 스키마는 어느 방법으로도 되돌아가지 않는다(runbook §3-0).

9. **공인 IP 가 바뀌면** (stop/start): 4·5 의 `OCI_DEPLOY_KNOWN_HOSTS`·`OCI_DEPLOY_HOST` 를
   `--env production` 으로 다시 올린다. 호스트 키 자체는 그대로이므로 지문 대조 결과는 같아야 한다.

**키 회수**: VM `~/.ssh/authorized_keys` 에서 `kubeport-gha-deploy` 줄 삭제 →
`gh secret delete OCI_DEPLOY_SSH_KEY --env production`.

## Upgrade

> **평소 이미지 갱신은 자동이다** (위 "자동 배포 설치", runbook §3-0). 수동으로 올려야 하면
> `ssh -i "$KEY" ubuntu@$IP kubeport-deploy deploy <40자리 sha>` 로 같은 스크립트·락을 탄다(runbook §3-2).
> 아래 raw helm 은 **값을 바꿀 때**(§7.6 데모 설정 등)만 쓰고, 그때도
> `flock -w 600 /run/lock/kubeport-deploy.lock helm upgrade ...` 로 같은 락을 잡는다.

이미지 태그 갱신 시 (스크립트가 없는 VM 에서의 예전 절차):

```bash
# VM 에서. 차트 사본(~/kubeport-chart/kubeport)을 먼저 main 과 동기화:
#   (로컬) git archive origin/main deploy/helm/kubeport deploy/oci | ssh ... 'mkdir -p ~/kubeport-src && tar -x -C ~/kubeport-src && cp -r ~/kubeport-src/deploy/helm/kubeport/. ~/kubeport-chart/kubeport/'
helm upgrade kubeport ~/kubeport-chart/kubeport \
  --namespace kubeport \
  --reset-then-reuse-values \
  --set images.backend.tag=$NEW_SHA \
  --set images.frontend.tag=$NEW_SHA
```

`--reset-then-reuse-values` 가 첫 install 의 secret 들과 데모 모드(`dex.*`/`demo.*`) 값을 유지하면서
새 차트 기본값도 반영한다. §7.6 의 최초 `--set` 목록을 한 번만 주면 이후 업그레이드에서는 다시 줄 필요가 없다.
**`-f values-oci-phase2.yaml` 은 업그레이드에 주지 않는다** — 빈 시크릿·플레이스홀더 `host` 가 릴리스 값을
덮어써 실패한다 (§7.6 주의 참조). `--reuse-values` 없이 `-f` 만 쓰면 데모 모드가 **꺼진다**. backend Pod 의 `migrate` initContainer 가 매번 `atlas schema apply` 를 다시 돌리므로 schema 변경도 자동 반영.

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
