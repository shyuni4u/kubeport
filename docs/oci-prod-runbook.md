# kubeport — OCI 프로덕션 운영 런북

현재 라이브 데모 환경(OCI Always Free A1, Phase 2)의 운영 지식을 한 곳에 모은다.
"어떻게 처음 세웠나"는 [deploy/oci/README.md](../deploy/oci/README.md), 근거는
[ADR 0003](decisions/0003-hosting-oci-always-free.md). 이 문서는 **이미 떠 있는 것을
어떻게 만지나**에 집중한다.

> ⚠️ **평문 시크릿을 이 파일에 넣지 말 것.** 값은 password manager / 로컬 파일에만.

## 1. 무엇이 어디 있나

| 항목 | 값 / 위치 |
|---|---|
| 라이브 URL | **https://kubeport.enzo.kr** |
| 공인 IP | `168.107.55.95` (⚠️ **ephemeral** — 인스턴스 stop/start 시 바뀜, 재부팅은 유지) |
| OCI 인스턴스 | `kubeport`, `VM.Standard.A1.Flex` 4 OCPU/24GB, Ubuntu 24.04 ARM, 리전 `ap-chuncheon-1` |
| SSH | `ssh -i ~/.ssh/kuberport-oci/oci_kuberport ubuntu@168.107.55.95` — `kuberport` 는 초기 오타지만 **실제 키 파일·디렉터리 이름**이라 그대로 쓴다 (이름을 바꾸면 gpg 번들·GHA 시크릿 스크립트도 같이 바꿔야 함; `upload-gha-secrets.sh` 는 `oci_kubeport.pub` 이 있으면 그것을 우선 쓴다) |
| SSH 키 출처 | gpg 번들 `kubeport-ssh.tar.gz.gpg`(대칭 암호화 — 별도 터미널에서 `gpg --pinentry-mode loopback -d ... \| tar -xz -C ~/.ssh/kuberport-oci`). 번들엔 키·config 만 있고 prod 시크릿 파일은 없음 — 시크릿은 Helm values 에서 조회 |
| 데모 시크릿 | Helm 릴리스 values 가 원본: `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm -n kubeport get values kubeport -o json \| jq '{pw:.demo.passwordHint, dex:.dex.clientSecret}'`. `DEMO_PW` 는 랜딩에 공개되는 값, `DEX_SECRET` 은 비밀번호 관리자에도 보관 |
| DNS | **GoDaddy** (`enzo.kr`, ns `domaincontrol.com`). A 레코드 2개: `kubeport` · `dex.kubeport` → 공인 IP. IP 변경 시 둘 다 갱신 |
| prod 시크릿 | `~/.ssh/kuberport-oci/kuberport-prod-secrets.env` (600). **password manager 로 옮길 것.** 담긴 것: `APP_ENCRYPTION_KEY_B64`(분실=DB 복호화 불가), `POSTGRES_PASSWORD`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| kubeconfig (VM 내) | `/etc/rancher/k3s/k3s.yaml` (`export KUBECONFIG=...` 후 `kubectl`) |
| Helm 릴리스 | `kubeport` (ns `kubeport`), 차트 VM 사본 `~/kubeport-chart/kubeport` |
| 이미지 | `ghcr.io/shyuni4u/kubeport-{backend,frontend}` 멀티아치(amd64+arm64), 태그 `sha-<shortsha>` |
| OCI 자격증명 (로컬) | `~/.oci/config`, `~/oci-capacity-retry/config.env` (compartment/AD/subnet OCID) |

## 2. 스택 구성

- **k3s** single-node (servicelb 켜짐 — klipper 가 호스트 80/443 → traefik LB).
- **traefik** ingress (`traefik` class), **cert-manager** + `letsencrypt-prod` ClusterIssuer (HTTP-01).
- **Postgres** in-cluster (`kubeport-postgres-0`, local-path PVC).
- backend(Go) / frontend(Next.js standalone) — TLS 는 traefik 종료, 파드엔 HTTP.
- 인증: Google OIDC. 사용자 토큰은 frontend httpOnly 쿠키 → backend 가 k8s API 로 포워딩.

## 3. 재배포 (이미지 갱신)

새 이미지는 `main` push 시 `build-images` 워크플로가 빌드·푸시(`sha-<sha>` + `latest`).
브랜치에서 미리 빌드하려면 `gh workflow run build-images.yml --ref <branch>` (dispatch 는 push
취급이라 이미지가 실제로 올라감). 그 뒤 VM 에서:

```bash
NEWSHA=<shortsha>   # 예: git rev-parse --short=7 HEAD
ssh -i ~/.ssh/kuberport-oci/oci_kuberport ubuntu@168.107.55.95 \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   helm upgrade kubeport ~/kubeport-chart/kubeport --namespace kubeport --reuse-values \
     --set images.frontend.tag=sha-$NEWSHA --set images.backend.tag=sha-$NEWSHA; \
   kubectl rollout status deploy/kubeport-frontend -n kubeport"
```

- 차트 **템플릿 자체**를 바꿨으면 먼저 `scp -r deploy/helm/kubeport ubuntu@...:~/kubeport-chart/`
  로 VM 사본을 갱신한 뒤 upgrade.
- `--reuse-values` 가 시크릿(enc key, pg pass, oidc)을 유지한다. 특정 값만 `--set` 으로 덮어씀.
- 롤아웃 직후 잠깐 `502` 가 날 수 있음(구 파드 종료↔신 파드 준비) — 30초 뒤 정상.

## 4. 인증 / RBAC (핵심 함정 모음)

Google OIDC 로 **로그인**과 **k8s 배포** 둘 다 돌리므로, 아래가 정확히 맞아야 한다.

- `oidc.clientId` = `oidc.audience` = **Google Client ID**. Google `id_token` 의 `aud` 가
  client_id 이고 backend verifier 와 k3s apiserver 둘 다 `aud == client_id` 를 강제한다.
  `audience` 기본값 `kubeport` 로 두면 **모든 로그인/배포가 튕긴다.**
- 로그인 scope 기본값 `openid email profile`. Google 은 `groups` scope 를 `invalid_scope` 로
  거부 → chart `oidc.scopes` 로만 그룹 IdP 에서 다시 켠다.
- Google 은 groups 클레임을 안 준다 → 첫 관리자는 `auth.devAdminEmails`(콤마구분, `--set-string`
  + 콤마 이스케이프)로 부트스트랩. 로그인 이메일 일치 시 in-app `kubeport-admin` 부여.
- **프록시 뒤 origin**: frontend 는 traefik 뒤라 `req.nextUrl.origin` 이 내부 주소
  (`https://0.0.0.0:3000`)로 잡힌다. auth 라우트는 `lib/request-origin.ts`(x-forwarded-host)로
  외부 origin 을 유도한다 — 로그인/로그아웃 리다이렉트가 깨지면 여길 본다.
  단, 유도한 값은 **허용 목록과 대조**한 뒤에만 쓴다. 목록은 `PUBLIC_ORIGIN`(콤마구분, 선택)이
  있으면 그것, 없으면 `OIDC_REDIRECT_URI` 의 origin 이다. 즉 차트가 이미 `OIDC_REDIRECT_URI` 를
  넣어 주므로 **운영에서 추가 설정은 필요 없다.** 목록 밖 호스트로 위조된 `X-Forwarded-Host` 는
  무시되고 첫 번째 허용 origin 으로 고정된다. 도메인을 여러 개 붙일 때만 차트 값
  `frontend.publicOrigins`(리스트)로 전부 나열한다 — ConfigMap 의 `PUBLIC_ORIGIN` 으로 렌더된다.
  둘 다 비면 헤더 값을 그대로 쓰고(로컬 개발용) 프로덕션에서는 기동 로그에 경고가 한 번 찍힌다.

## 5. 실제 배포 활성화 (k3s ↔ Google OIDC ↔ RBAC ↔ 클러스터 등록)

앱이 **실제로 k8s 에 배포**하려면 아래 4가지가 서버에 세팅돼 있어야 한다.
(상세 절차·재현은 [deploy/oci/README.md §7](../deploy/oci/README.md) 참조.)

1. **k3s 가 Google(+ Dex 데모) 토큰을 인증으로 수용** — 구조화된 `AuthenticationConfiguration`
   (`/etc/rancher/k3s/auth.yaml`, `--oidc-*` 플래그와 동시 사용 불가):
   ```yaml
   apiVersion: apiserver.config.k8s.io/v1   # k8s 1.30–1.33 은 v1beta1
   kind: AuthenticationConfiguration
   jwt:
     - issuer:
         url: https://accounts.google.com
         audiences: ["<GOOGLE_CLIENT_ID>"]
       claimMappings:
         username: { claim: email, prefix: "" }      # '' = 접두어 없음 → username == raw email
     - issuer:
         url: https://dex.kubeport.enzo.kr
         audiences: ["kubeport-demo"]
       claimMappings:
         username: { claim: email, prefix: "dex:" }
   ```
   `/etc/rancher/k3s/config.yaml` 은 `kube-apiserver-arg: ["authentication-config=/etc/rancher/k3s/auth.yaml"]`
   만 남긴다. `bootstrap.sh` 가 Google 부분을 먼저 쓰고, Dex 는 `deploy/oci/k3s-auth-config.sh` 로
   나중에(Dex ingress 가 뜬 뒤) 추가한다 — 상세: [deploy/oci/README.md §7.1, §7.6](../deploy/oci/README.md).
   ⚠️ **값을 반드시 따옴표로.** 끝에 콜론이 있으면 YAML 이 맵으로 파싱해 apiserver 가
   `unknown flag: --[{...}]` 로 죽는다. 적용: `sudo systemctl restart k3s`.
   **롤백**: `sudo ROLLBACK=1 bash deploy/oci/k3s-auth-config.sh` — `config.yaml.bak` 복원 + 재기동 + 검증까지 자동.
2. **pod → apiserver 방화벽** — OCI Ubuntu 이미지는 끝단에서 전부 REJECT 한다. bootstrap 이
   80/443 만 열어서, **pod/service CIDR 을 안 열면 pod→apiserver(6443) 가 막혀 배포가 전부 실패**한다:
   ```bash
   sudo iptables -I INPUT 1 -s 10.42.0.0/16 -j ACCEPT   # pod CIDR
   sudo iptables -I INPUT 1 -s 10.43.0.0/16 -j ACCEPT   # service CIDR
   sudo netfilter-persistent save
   ```
3. **RBAC** — 오너(Google) 이메일은 cluster-admin 유지, 데모 사용자(`dex:demo-admin@demo.kubeport` /
   `dex:demo-user@demo.kubeport`)는 **chart 가 네임스페이스(`demo`) 스코프 RoleBinding 을 만들어준다**
   (cluster-admin 바인딩 불필요 — Plan 13 Dex chart 참조):
   ```bash
   kubectl create clusterrolebinding kubeport-owner-admin \
     --clusterrole=cluster-admin --user="<owner Google email>"
   ```
4. **클러스터를 배포 대상으로 등록** — `POST /v1/clusters`(admin 전용). in-cluster 값:
   - `api_url`: `https://kubernetes.default.svc`
   - `ca_bundle`: k3s 서버 CA (`/var/lib/rancher/k3s/server/tls/server-ca.crt`)
   - `oidc_issuer_url`: `https://accounts.google.com`, `default_namespace`: `default`
   현재 `oci-a1` 이 이렇게 등록돼 있다.

> **Dex 서명 키 회전 주의**: 데모 Dex chart 는 `storage: memory` — Dex pod 가 재시작하면 서명 키가
> 바뀐다. apiserver 는 issuer 의 JWKS 를 캐싱하므로 재시작 직후 짧은 창 동안 기존 발급 토큰이
> 아니라도 **새로 발급된** 토큰이 401 로 거부될 수 있다(캐시가 아직 새 키를 못 받아옴). 보통
> k8s 가 자동으로 짧은 주기 뒤 JWKS 를 다시 받아오며 해결된다. 안 풀리면 `sudo systemctl restart k3s`
> 로 캐시를 강제로 비운다.

### 데모 모드 운영 (Plan 13, 2026-09-08 롤아웃 완료)

- **구성**: Helm revision ≥ 4 에 `dex.enabled=true` / `demo.enabled=true`, `demo.kubectlImage=alpine/k8s:1.31.9`.
  k3s 는 `/etc/rancher/k3s/auth.yaml` 로 Google + Dex 를 신뢰(`config.yaml.bak` 이 전환 전 백업).
- **데모 비밀번호 회전**: [deploy/oci/README.md §7.6](../deploy/oci/README.md) 의 `--set` 목록을
  새 `DEMO_PW`/`HASH` 로 다시 실행 (`staticPasswords[N]` 네 필드 전부, `--reset-then-reuse-values`).
  `DEX_SECRET` 은 유지해도 된다. Dex 는 `storage: memory` 라 재시작 시 서명 키가 바뀐다 (§5 주의 참조).
- **리셋**: CronJob `kubeport-demo-reset` 6시간 주기. 수동: `kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset demo-reset-manual`
  → 로그 `seed-demo: done`. wipe 단계가 `demo` ns 의 configmap 을 전부 지우므로 `kube-root-ca.crt deleted` 가 찍히는 건 정상(자동 재생성).
- **오너 RBAC**: 오너 Google 이메일의 cluster-admin 바인딩 이름은 `kubeport-owner-admin`
  (예전 이름 `kubeport-demo-admin` 은 이름과 달리 오너 바인딩이었음 — 삭제 전 subject 확인).
  데모 계정은 chart 의 `demo` ns RoleBinding 만 갖는다. 검증: `kubectl auth can-i create deployments --as=dex:demo-user@demo.kubeport -n default` → **no**.
- **데모 계정의 템플릿 저작**: 기본은 **막혀 있다**(`POST /v1/templates` → 403 `demo-restricted`).
  데모 계정은 `kubeport-admin` 을 갖지만, 저작은 결과물이 방문자의 세션보다 오래 남고 남에게 보이는
  유일한 관리자 권한이라서다. 저작 체험까지 보여주려면 `--set demo.allowTemplateCreate=true`
  (backend `KBP_DEMO_ALLOW_TEMPLATE_CREATE`). 켜도 데모가 만든 템플릿은 실제 사용자 카탈로그에
  안 보이지만, 누군가 그걸로 배포하면 6시간 리셋이 그 템플릿을 건너뛴다(`tolerateFK`).
  결정 근거: [brainstorming-summary §14](brainstorming-summary.md).
  **리셋 CronJob 은 이 플래그와 무관하다** — 시드는 API 가 아니라 DB 로 직접 쓴다
  (`cmd/seed-demo/templates.go`). 한때 API 를 타서, 게이트가 닫힌 상태로 배포하자 6시간마다
  데모가 비워졌다([#104](https://github.com/shyuni4u/kubeport/issues/104)). 시드가 실패하면
  잡이 Failed 로 남고 카탈로그가 빈 채로 방치되니, 배포 후 한 번은
  `kubectl -n kubeport get job` 으로 확인할 것.
- **Dex 호스트도 ephemeral IP 를 본다**: VM stop/start 후 `dex.kubeport.enzo.kr` A 레코드까지 갱신하지 않으면
  인증서 갱신·데모 로그인이 깨진다.

### k3s 재기동 롤백 (apiserver 가 안 뜰 때)
```bash
sudo ROLLBACK=1 bash deploy/oci/k3s-auth-config.sh   # config.yaml.bak 복원 + 재기동 + 검증
# 스크립트 없이 수동으로:
sudo cp /etc/rancher/k3s/config.yaml.bak /etc/rancher/k3s/config.yaml
sudo systemctl restart k3s
# 검증: sudo k3s kubectl get --raw=/readyz  → "ok"
```
> ⚠️ k3s 재기동은 컨트롤플레인 ~30초 블립(앱 파드는 유지). config 오류 시 apiserver 가
> crash-loop 하므로, 재기동 명령은 **반드시 롤백까지 한 번에** 묶어서 실행할 것.

## 6. 운영 / 관측

- **idle reclaim 방지**: `.github/workflows/uptime-ping.yml` 가 10분마다 URL ping (OCI 는
  7일 p95 CPU·네트워크·메모리 **모두** <20% 여야 회수 대상 → ping 으로 회피).
- **백업**: 커스텀 정책 `kubeport-weekly-4w`(주간 증분, 28일 보존 = 최대 4개, 무료 5개 한도 내)가
  boot volume 에 연결됨. Postgres 데이터(local-path PVC)도 boot volume 안이라 함께 보존.
  ⚠️ Oracle 기본 **Bronze 는 월간/연간 장기보존이라 무료 한도 초과 → 쓰지 말 것.**
- **세션 보관 정책**: 유예 없음 — 만료된 행은 **다음 정리 주기(기본 1시간)** 에 삭제된다. backend 가
  기동 직후 한 번, 이후 1시간마다 `expires_at < now()` 인 `sessions` 행을 1000개씩, 한 주기 최대
  20회(=2만 행)까지 지운다(`internal/session` reaper). 만료된 세션은 이미 사용 불가이고 행에는
  암호화된 id/refresh token 만 남으므로 보관할 이유가 없다 — PVC 용량과 주간 백업 크기를 함께 줄인다.
  **밀린 백로그가 2만 행을 넘으면 여러 주기에 걸쳐 나눠 빠지므로, 첫 배포 직후 한 번에 줄지 않는 것은
  정상이다.** 주기는 차트 값 `backend.sessionReapInterval`(Go duration, 예 `30m` → ConfigMap 의
  `KBP_SESSION_REAP_INTERVAL`)로 조정하며, 1분 미만은 1분으로 잘린다.
  삭제량은 backend 로그에 `session reaper: removed N expired sessions` 로 남는다.
- **로그**: `kubectl logs -n kubeport deploy/kubeport-{frontend,backend}`. k3s: `journalctl -u k3s`.
- **인증서**: `letsencrypt-prod` 자동 갱신(만료 30일 전). `kubectl get certificate -n kubeport`.

## 7. 자주 겪는 증상 → 원인

| 증상 | 확인 |
|---|---|
| 로그인 후 `redirect_uri_mismatch` | Google 콘솔 Authorized redirect URI 가 정확히 `https://kubeport.enzo.kr/api/auth/callback` 인지(`kubeport`↔`kuberport` 오타 주의 — 단 SSH 키 경로 `~/.ssh/kuberport-oci/` 는 실제 이름이라 그대로 둔다). authorize 는 되고 token 만 실패하면 콜백이 내부 host 로 redirect_uri 를 보낸 것 → `callback/route.ts` 가 `OIDC_REDIRECT_URI` 를 쓰는지 |
| 로그인 시 `invalid_scope` | `groups` scope. `oidc.scopes` 기본(`openid email profile`)이면 안 나야 함 |
| 배포가 조용히 실패 | pod→apiserver 차단(§5-2 iptables) 또는 사용자에 RBAC 바인딩 없음(§5-3) |
| 홈 `502` | 롤아웃 순간 일시적. 30초 뒤 재확인. 지속되면 파드 로그 |
| 좌측하단 클러스터 비어있음 | 등록 클러스터 0개 — §5-4. `kubectl exec ... psql -c "select name from clusters"` |
| 로그아웃 무반응 | 프록시 origin(§4) 또는 리다이렉트 status(303 이어야 함) |
| 로그인 후 `/` 로 되돌아오고 "로그인하지 못했습니다" 배너 | 콜백이 `?login_error=` 로 돌려보낸 것. 원인은 화면에 안 나오므로 `kubectl logs -n kubeport deploy/kubeport-frontend \| grep '\[auth/callback\]'` 확인. `cancelled` = 사용자가 동의화면에서 취소, `expired` = 10분 state 쿠키 만료, `failed` = IdP/DB 오류. 로그에 `suspicious=true` 면 state/nonce 불일치 — 콜백 위조·재생 시도일 수 있다 |
| 로그아웃이 403 `cross-origin request rejected` | 브라우저가 보는 origin 이 허용목록(§4)에 없다. 도메인을 추가했거나 **TLS 를 클러스터 밖에서 종료하면서 `tls.enabled=false`** 로 뒀다면 `frontend.publicOrigins` 에 실제 https origin 을 넣고 `helm upgrade` |
| 데모 로그인 후 배포 401/403 | k3s `auth.yaml` 에 Dex issuer 있는지, prefix `dex:` 와 RoleBinding subject 일치하는지 |
| "템플릿이 안 보여요" / 버전 상세 403·404 | 대부분 publish 누락이다. 초안은 소유자에게만 보인다(전역=`kubeport-admin`, 팀=그 팀 멤버). admin 토큰으로 `GET /v1/templates/<name>/versions` 를 호출해 draft 만 있는지 먼저 확인 |

## 8. 보안 후속 (권장)

- **SSH 키 회전** — 공인 IP 노출 + 키가 OCI capacity 폴링 GHA 시크릿에 있음. 안전 절차:
  새 키 생성 → `authorized_keys` 에 추가 → 새 키 접속 검증 → 구 키 제거 → gpg 번들/GHA 시크릿 갱신.
- **공인 IP reserved 전환** — stop/start 대비. 전환 시 IP 변경 → DNS·인증서 재발급(유지보수 창 필요).
- ~~**RBAC 스코프 축소** — 데모 cluster-admin → 네임스페이스 스코프 role.~~ **완료** — 데모 사용자는
  chart 의 네임스페이스(`demo`) 스코프 RoleBinding 사용, 오너만 cluster-admin (§5-3).

## See also
- [deploy/oci/README.md](../deploy/oci/README.md) — 최초 부트스트랩 절차
- [ADR 0003](decisions/0003-hosting-oci-always-free.md) — 호스팅 결정
- [docs/local-e2e.md](local-e2e.md) — 로컬(kind+dex) 등가 셋업
- [Plan 10](superpowers/plans/2026-06-24-plan10-oci-phase2-bootstrap.md) — Phase 2 플랜
- [docs/plan13-handoff.md](plan13-handoff.md) — 데모 모드(Plan 13) 프로덕션 롤아웃·후속 과제 인계 체크리스트
