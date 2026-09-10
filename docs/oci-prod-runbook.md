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
| SSH | `ssh -i "$KEY" ubuntu@168.107.55.95` — **`$KEY` 는 머신마다 다르다. 아래 "SSH 키 위치" 를 먼저 읽을 것.** `kuberport` 는 초기 오타지만 **실제 키 파일·디렉터리 이름**이라 그대로 쓴다 (이름을 바꾸면 gpg 번들·GHA 시크릿 스크립트도 같이 바꿔야 함; `upload-gha-secrets.sh` 는 `oci_kubeport.pub` 이 있으면 그것을 우선 쓴다) |
| SSH 키 출처 | gpg 번들 `kubeport-ssh.tar.gz.gpg`(대칭 암호화 — 별도 터미널에서 `gpg --pinentry-mode loopback -d ... \| tar -xz -C ~/.ssh/kuberport-oci`). 번들엔 키·config 만 있고 prod 시크릿 파일은 없음 — 시크릿은 Helm values 에서 조회 |
| 데모 시크릿 | Helm 릴리스 values 가 원본: `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm -n kubeport get values kubeport -o json \| jq '{pw:.demo.passwordHint, dex:.dex.clientSecret}'`. `DEMO_PW` 는 랜딩에 공개되는 값, `DEX_SECRET` 은 비밀번호 관리자에도 보관 |
| DNS | **GoDaddy** (`enzo.kr`, ns `domaincontrol.com`). A 레코드 2개: `kubeport` · `dex.kubeport` → 공인 IP. IP 변경 시 둘 다 갱신 |
| prod 시크릿 | `~/.ssh/kuberport-oci/kuberport-prod-secrets.env` (600). **password manager 로 옮길 것.** 담긴 것: `APP_ENCRYPTION_KEY_B64`(분실=DB 복호화 불가), `POSTGRES_PASSWORD`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` |
| kubeconfig (VM 내) | `/etc/rancher/k3s/k3s.yaml` (`export KUBECONFIG=...` 후 `kubectl`) |
| Helm 릴리스 | `kubeport` (ns `kubeport`), 차트 VM 사본 `~/kubeport-chart/kubeport` (배포 스크립트가 배포할 때마다 그 sha 의 chart 로 갱신 — `.deployed-sha` 파일) |
| 배포 | **자동**: `.github/workflows/deploy.yml` → VM `/usr/local/bin/kubeport-deploy` (forced command). 락 `/run/lock/kubeport-deploy.lock`. 지금 라이브: `curl -s https://kubeport.enzo.kr/api/healthz \| jq -r .version` (§3) |
| 이미지 | `ghcr.io/shyuni4u/kubeport-{backend,frontend}` 멀티아치(amd64+arm64), 태그 `sha-<shortsha>` |
| OCI 자격증명 (로컬) | `~/.oci/config`, `~/oci-capacity-retry/config.env` (compartment/AD/subnet OCID) |

### SSH 키 위치 — 두 곳 다 정상이다 (#68)

키 경로가 문서마다 갈려 보이는 것은 오타가 아니라 **키를 어떻게 손에 넣었느냐가 두 가지**이기
때문이다. 접속 전에 어느 쪽인지부터 확인한다:

```bash
ls -l ~/.ssh/oci_kuberport ~/.ssh/kuberport-oci/oci_kuberport 2>/dev/null
```

| 어떻게 얻었나 | 경로 |
|---|---|
| **키를 만든 머신** (부트스트랩을 직접 돌린 곳) | `~/.ssh/oci_kuberport` — 홈 바로 아래, 디렉터리 없음 |
| **gpg 번들로 복원한 머신** | `~/.ssh/kuberport-oci/oci_kuberport` — `tar -xz -C ~/.ssh/kuberport-oci` 가 만드는 디렉터리 |

`deploy/oci/README.md` 는 앞쪽을, 이 런북은 뒤쪽을 적고 있었고 **둘 다 맞다.** 한쪽으로
"통일" 하면 반대쪽 머신에서 반드시 깨지므로 통일하지 않는다.

2026-09-09 재배포 때 이 문서의 경로를 그대로 복사했다가
`Identity file ~/.ssh/kuberport-oci/oci_kuberport not accessible` → `Permission denied (publickey)`
로 막혔다. 그 머신은 키를 만든 쪽이라 `~/.ssh/` 아래가 평평했다. 아래 명령들이 경로를
하드코딩하지 않고 `$KEY` 를 쓰는 이유다 — 세션 시작할 때 한 번 잡아 두면 된다:

```bash
KEY=~/.ssh/oci_kuberport
[ -f "$KEY" ] || KEY=~/.ssh/kuberport-oci/oci_kuberport
# 폴백은 파일이 없어도 조용히 통과한다 — 둘 다 없으면 여기서 잡는다
[ -f "$KEY" ] || echo "두 경로 어디에도 키가 없다: 이 머신은 아직 gpg 번들을 안 풀었다"
echo "KEY=$KEY"
```

`prod 시크릿`(`kuberport-prod-secrets.env`)도 gpg 번들을 푼 머신에만 있다. 키를 만든 머신에는
없으므로, 시크릿이 필요하면 Helm values 에서 조회한다(§1 "데모 시크릿" 행과 같은 방법).

## 2. 스택 구성

- **k3s** single-node (servicelb 켜짐 — klipper 가 호스트 80/443 → traefik LB).
- **traefik** ingress (`traefik` class), **cert-manager** + `letsencrypt-prod` ClusterIssuer (HTTP-01).
- **Postgres** in-cluster (`kubeport-postgres-0`, local-path PVC).
- backend(Go) / frontend(Next.js standalone) — TLS 는 traefik 종료, 파드엔 HTTP.
- 인증: Google OIDC. 사용자 토큰은 frontend httpOnly 쿠키 → backend 가 k8s API 로 포워딩.

## 3. 재배포 (이미지 갱신)

새 이미지는 `main` push 시 `build-images` 워크플로가 빌드·푸시(`sha-<sha>` + `latest`).
**ghcr 에 올리는 것은 push 이벤트뿐이다** — main push 와 `v*` 태그 push. `gh workflow run build-images.yml --ref <branch>`
는 두 아키텍처로 **빌드만** 하고 올리지 않는다("브랜치가 arm64 로도 빌드되나" 확인용). dispatch 로 올리게 두면
main 에 없는 커밋이 배포 스크립트가 쓰는 `sha-<7>` 태그를 차지할 수 있어서다. 브랜치 이미지를 미리 배포해 볼 길은 없다 — main 에 넣는다.

**PR 에서는 이미지가 만들어지지 않는다** — `build-images` 는 PR 에서도 돈다. #122 가 트리거를
없앤 게 아니라 `paths:` 필터를 붙였고(Dockerfile·lockfile·`next.config.ts` 등 11개 경로), 빌드
스텝이 `push: ${{ github.event_name != 'pull_request' }}` 라 **"아직 빌드되나" 만 답하고 ghcr 에는
아무것도 올리지 않는다.** 이미지는 **main 에 들어간 뒤에야** 존재한다. 대신 #122 가 `push:` 쪽 `paths:` 필터를 없앴으므로
이제 **모든 main 커밋에 `sha-<7>` 태그가 생긴다** — 예전에는 docs 만 바뀐 커밋이 HEAD 면 태그가
없어서 배포할 sha 가 없었다.

### 3-0. 자동 배포 (기본)

main 에 머지하면 사람 손 없이 라이브까지 간다. 설치 절차는
[deploy/oci/README.md "자동 배포 설치"](../deploy/oci/README.md#자동-배포-설치-github-actions--vm).

```
main push → build-images (sha-<7> 이미지 push)
          → deploy.yml (workflow_run — 성공한 main push 빌드만)
          → 전용 배포 키로 ssh → VM forced command: kubeport-deploy "deploy <40자리 sha>"
          → helm upgrade (실패 시 helm 이 자동 롤백)
          → https://kubeport.enzo.kr/api/healthz 의 version 이 sha 7자리가 될 때까지 대기 (5분)
```

- **지금 라이브가 어느 커밋인가**: `curl -s https://kubeport.enzo.kr/api/healthz | jq -r .version` —
  ssh 없이 누구나 본다. backend 빌드의 sha 다(frontend 는 같은 커밋·같은 배포로 함께 올라간다).
- **건너뛰기**: 워크플로가 실제로 돌 때 그 sha 가 이미 main HEAD 가 아니면 배포하지 않고 notice 만
  남긴다. 더 새 커밋의 빌드가 끝나면 그쪽 배포가 두 커밋을 함께 올린다. 빌드는 끝나는 순서가
  섞이므로, 이게 없으면 늦게 끝난 **옛 커밋의 배포가 라이브를 뒤로 되돌린다.** 대가: 새 커밋의
  빌드가 실패하면 아무것도 안 올라간다 — 그 빌드의 빨간 불이 신호이고, 필요하면 아래 dispatch.
- **동시성**: `concurrency: deploy-prod`, 진행 중인 배포는 취소하지 않는다(ssh 가 끊겨 helm 이
  `pending-upgrade` 로 남으면 이후 모든 upgrade 가 막힌다). 수동 배포와는 VM 의 같은 락으로 직렬화된다.
- **재배포 (앞으로만)**: Actions → deploy → Run workflow, 또는
  `gh workflow run deploy.yml -f sha=<main 커밋 40자리>`. dispatch 는 HEAD 검사를 하지 않는 대신
  그 sha 가 main 에 있고 build-images 가 성공했는지 먼저 확인한다. 그리고 VM 이 **지금 라이브와 같거나
  그보다 새 커밋만** 받는다(`deploy/kubeport-backend` 의 `sha-<7>` 태그 기준, GitHub compare 가
  `ahead`/`identical`). 유출된 배포 키로 보안 수정 이전 빌드를 되살리지 못하게 하려는 것이다.
- **롤백은 관리자 키로 `kubeport-deploy deploy <sha>`** (§3-2). 배포 키 경로로 옛 sha 를 주면
  `refused-not-forward`(exit 2)로 아무것도 안 바뀐다. 롤백 전에 `gh workflow disable deploy.yml` — 안 그러면
  다음 main 커밋의 자동 배포가 다시 앞으로 간다. `version` 필드가 생기기 전 빌드로 되돌렸다면 그 빌드는
  version 을 보고하지 않는다(dispatch 의 `verify_version=false` 는 그 상태에서 다시 앞으로 갈 때만 쓸 일이 있다).
  - ⚠️ 롤백은 **이미지·템플릿만** 되돌린다. backend 의 `migrate` initContainer 가 이미 적용한
    스키마 변경은 그대로다 — 스키마를 바꾼 커밋 이전으로 갈 때는 옛 코드가 새 스키마에서 도는지 먼저 본다.
    helm 의 자동 롤백도 같은 한계를 갖는다.
- **실패 읽기** — Actions 요약의 `result:` (스크립트의 `KUBEPORT_DEPLOY_RESULT=` 줄). 워크플로 메시지도
  exit 코드가 아니라 이 줄로 갈린다 — exit 1 에는 "아무것도 안 바뀜" 과 "새 리비전이 롤백 없이 떠 있음" 이
  함께 들어 있어서다:

  | result (exit) | 클러스터 | 뜻 | 할 일 |
  |---|---|---|---|
  | `deployed` (0) | 새 리비전 | 배포 완료 | 다음 단계가 healthz version 으로 한 번 더 확인 |
  | `dex-guard-refused` (10) | 안 바뀜 | **Dex 가드 거절** | §3-4 수동 절차 |
  | `refused-not-forward` (2) | 안 바뀜 | 요청 sha 가 라이브보다 옛것·갈라짐, 또는 라이브 태그가 `sha-<7>` 이 아님, 또는 GitHub 조회 실패 | 롤백이 목적이면 관리자 키(§3-2). 라이브 태그가 `latest` 등이면 관리자 키로 한 번 배포해 `sha-<7>` 로 맞춘다 |
  | `rejected` (2) | 안 바뀜 | 요청 형식 거절, 또는 authorized_keys 줄에 `--forced` 가 없음 | README "자동 배포 설치" 3단계 |
  | `lock-busy` (3) | 안 바뀜 | 락 10분 대기 초과 (수동 배포 진행 중) | 끝난 뒤 re-run |
  | `unverified` (4) | 안 바뀜 | sha 가 main 에 없음 / GitHub 확인·chart 다운로드 실패 / 그 커밋에 chart 없음 | sha, GitHub 상태 |
  | `aborted-before-upgrade` (1) | 안 바뀜 | upgrade 전에 멈춤 — 릴리스 값 없음, `helm template` 실패, Dex 비교 불가, 릴리스가 `pending-*`, helm 버전 미인식 | 로그의 `ERROR:` 줄. `pending-*` 면 §7 "another operation" |
  | `failed-rolled-back` (1) | **이전 리비전** | helm upgrade 실패 → helm 이 자동 롤백 | 로그의 `helm history`, `kubectl get events -n kubeport` |
  | `failed-rollout` / `failed-image-mismatch` / `failed-values-drift` / `failed-after-upgrade` (1) | **새 리비전, 롤백 안 됨** | upgrade 는 성공했는데 rollout·이미지 태그·값 확인이 실패 | `helm history` 로 새 리비전 확인 → 유지하거나 관리자 키로 롤백(§3-2) |
  | `failed-during-upgrade` (1) | 알 수 없음 | helm upgrade 도중 스크립트가 끝남 | `kubeport-deploy status`, `pending-upgrade` 면 §7 |
  | 없음 (255) | 알 수 없음 | ssh 접속 실패, 또는 도중에 세션이 끊김 | 로그가 스크립트까지 못 갔으면 IP 변경 → `OCI_DEPLOY_HOST`·`OCI_DEPLOY_KNOWN_HOSTS` 갱신. `helm upgrade` 가 찍혔으면 `kubeport-deploy status` |

- **자동 배포 멈추기**: `gh workflow disable deploy.yml` (다시 `enable`). 다음 런부터 막는다. 키 자체를
  막으려면 VM 의 `~/.ssh/authorized_keys` 에서 `kubeport-gha-deploy` 줄을 지운다.
  - ⚠️ **진행 중인 deploy 런은 Cancel 하지 않는다.** Cancel 은 ssh 세션을 끊고, `helm upgrade` 도중이면
    릴리스가 `pending-upgrade` 로 남아 이후 **모든** upgrade(자동·수동·비밀번호 회전)가
    `another operation (install/upgrade/rollback) is in progress` 로 막힌다. disable 해 두고 런이 끝나기를
    기다린다 — 최대 45분(Deploy 스텝 timeout: 락 대기 10분 + helm 10분 + 롤백 대기 + rollout 확인).
    이미 끊겼다면 §7 의 그 증상 행.
- **VM 의 스크립트는 자동 갱신되지 않는다.** main 의 `deploy/oci/kubeport-deploy.sh` 가 바뀌어도
  `/usr/local/bin/kubeport-deploy` 는 그대로다 — 커밋 하나로 배포 키가 할 수 있는 일이 바뀌지 않게
  하려는 의도다. 스크립트가 바뀌면 README "자동 배포 설치" 2단계를 다시 실행한다.
- **uptime-ping 과**: 롤아웃 순간의 짧은 502 창(§3-2 끝)에 10분 핑이 걸리면 uptime-ping 이 한 번
  빨갛게 될 수 있다. 배포 직후의 빨간 핑 1회는 deploy 런 시각과 먼저 대조한다.

### 3-1. 태그가 실제로 있는지 먼저 확인

(자동 배포는 workflow_run 이 곧 "빌드 성공" 이고, dispatch 는 워크플로가 이 확인을 대신한다.
아래는 수동 배포할 때.)

없는 태그로 `helm upgrade` 하면 `ImagePullBackOff` 로 끝나고 롤아웃이 타임아웃까지 매달린다.

```bash
git fetch origin main          # origin/main 은 로컬 캐시다 — fetch 없이는 옛 sha 가 나온다
NEWSHA=$(git rev-parse --short=7 origin/main)
gh run list --workflow build-images.yml --branch main --limit 30 \
  --json headSha,conclusion,databaseId \
  -q ".[] | select(.headSha[0:7]==\"$NEWSHA\")"
```

⚠️ **`git fetch` 를 빠뜨리면 이 명령은 에러 없이 예전 sha 를 돌려준다.** 그 sha 에도 이미지가
있으니 아래 태그 확인도, §3-3 배포 확인도 전부 초록으로 통과한다 — 실패가 아니라 **조용한 롤백**
으로 끝난다.

⚠️ `gh run list --commit <sha>` 는 **행이 있어도 조용히 0건을 돌려준다.** 위처럼 `--branch main`
으로 받아 클라이언트에서 거르는 편이 확실하다. 0 건이면 태그가 없는 게 아니라 `--limit` 이 모자란
것일 수 있다 — 이제 모든 main 커밋에 런이 생기므로 조금만 뒤처진 sha 는 금방 창 밖으로 밀린다. `conclusion` 이 `success` 인지까지 본다 — 워크플로가
성공해도 `frontend`/`backend` 잡 중 하나만 실패했을 수 있으므로 확실히 하려면
`gh run view <databaseId> --json jobs -q '.jobs[] | "\(.name) \(.conclusion)"'`.

(`gh api user/packages/container/.../versions` 로 ghcr 를 직접 보는 길은 `read:packages` 스코프가
없으면 403 이다. 워크플로 잡 결과가 스코프 없이 확인 가능한 근거다.)

### 3-2. 수동 배포 (예외)

자동 배포가 거절했거나(§3-4 Dex), **롤백할 때**, 워크플로를 쓸 수 없을 때(GitHub 장애, 시크릿 미설정).
**같은 스크립트를 관리자 키로 부른다** — 락·main 검증·Dex 가드·자동 롤백을 그대로 탄다. 배포 키와 다른
점은 둘뿐이다: `--allow-dex-restart` 를 받고, 라이브보다 옛 커밋(롤백)도 받는다:

```bash
# $KEY 는 §1 "SSH 키 위치" 참조. 7자리가 아니라 40자리 전체 sha 를 준다.
git fetch origin main          # 빠뜨리면 옛 sha 로 "조용한 롤백" (§3-1)
FULLSHA=$(git rev-parse origin/main)
ssh -i "$KEY" ubuntu@168.107.55.95 kubeport-deploy deploy "$FULLSHA"
```

`sudo` 를 붙이지 않는다 — kubeconfig 가 0644 라 필요 없고, 붙이면 락·작업 파일이 root 소유로 남는다.
스크립트가 하는 일(원본은 `deploy/oci/kubeport-deploy.sh` 머리 주석):

1. `/run/lock/kubeport-deploy.lock` 을 `flock` 으로 잡는다(최대 10분 대기). 워크플로와 수동이 같은 락이다.
2. GitHub compare API 로 sha 가 main 에 있는지 확인. 아니면 거절(exit 4). 배포 키가 새도 "이미 머지된
   커밋 재배포" 이상은 못 하게 하는 장치다 — GitHub 은 포크에만 있는 커밋도 원 리포 archive URL 로 내준다.
   **배포 키 경로(`--forced`)는 여기에 더해 앞으로만 간다**: 라이브 `deploy/kubeport-backend` 의 태그
   `sha-<7>` 과 요청 sha 를 compare 해 `ahead`/`identical` 이 아니면 exit 2(`refused-not-forward`,
   "rollback needs the admin key"). 라이브 태그가 `sha-<7hex>` 모양이 아니어도 거절한다. 관리자 키 경로는
   이 검사를 하지 않는다 — 롤백은 이 경로로 한다.
   이어서 릴리스가 `pending-*` 면 upgrade 전에 멈춘다(`aborted-before-upgrade`, §7).
3. **chart 는 그 sha 의 GitHub tarball 에서 받는다.** VM 사본이 아니다 — 이미지와 템플릿이 같은
   커밋으로 짝지어지므로 "scp 를 잊어 옛 템플릿으로 배포" 가 없어지고, sha 로 롤백하면 둘 다 되돌아간다.
   성공하면 `~/kubeport-chart/kubeport` 를 그 chart 로 갱신한다(아래 값 변경 절차가 옛 템플릿을 안 쓰게).
4. 값은 `helm get values`(릴리스에 저장된 사용자 값 — 시크릿·데모 게이트·install 때의 phase2 값)를
   **새 chart 의 기본값 위에** 얹는다. `--reset-then-reuse-values` 와 같은 의미를 파일로 명시한 것이라,
   Dex 가드가 업그레이드와 글자 하나 다르지 않은 입력으로 렌더한다. **아래 `--reuse-values` 새 키 함정이
   이 경로엔 없다** (`--reuse-values` 는 옛 chart 의 기본값을 쓰기 때문에 새 키가 비는 것이다).
5. Dex 가드(§3-4) → `helm upgrade` + helm 3 `--atomic` / helm 4 `--rollback-on-failure`(런타임 판별,
   timeout 10m) → `rollout status` → `helm history | tail -3` + 배포된 이미지 태그 출력 + 태그 대조.
6. **배포 후 `helm get values` 재확인.** `demo.resetHostAliasIP`(빠지면 리셋 Job preflight 실패 §5)·
   `demo.publicHealthCatalog`(빠지면 uptime-ping 이 눈을 감음)·`demo.allowTemplateCreate`(데모 저작 게이트)
   를 `이전 -> 이후` 로 찍고, `images.*.tag` 외의 사용자 값이 하나라도 바뀌었으면 exit 1
   (`failed-values-drift`, 바뀐 최상위 키 이름만 출력). 롤백은 자동으로 하지 않는다 — 릴리스는 떠 있고
   유지 여부는 사람이 판단한다. 셋 중 하나가 `<unset>` 이면 경고.

VM 사본을 쓰지 않는 이유의 실례: 2026-09-10 rev 19 수동 배포 때 사본이 main 과 34파일 전부 일치했는데,
그건 배포하던 세션이 막 `scp` 로 맞춰 놨기 때문이었다. 사본은 그렇게 사람이 기억할 때만 맞는다.

**raw `helm upgrade` 에는 락도 가드도 없다.** 스크립트가 못 하는 일 — 값 바꾸기(데모 비밀번호 회전 §5,
새 `--set`) — 만 직접 치고, 그때도 같은 락을 잡는다:

```bash
ssh -i "$KEY" ubuntu@168.107.55.95 \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   flock -w 600 /run/lock/kubeport-deploy.lock \
     helm upgrade kubeport ~/kubeport-chart/kubeport --namespace kubeport --reuse-values --set <키>=<값>"
```

직접 칠 때의 함정:

- ⚠️ **`export KUBECONFIG=...` 를 ssh 명령마다 넣어야 한다.** 빠뜨리면 `helm`·`kubectl` 이
  `Kubernetes cluster unreachable: Get "http://localhost:8080/version"` 로 죽는다. 로그인 셸이
  아니라 `ssh <host> "<command>"` 형태라 프로필이 안 읽힌다. (배포 스크립트는 스스로 설정한다.)
- `~/kubeport-chart/kubeport` 는 마지막 **스크립트 배포**의 chart 다(`cat ~/kubeport-chart/kubeport/.deployed-sha`).
  raw helm 으로 이미지 태그를 올리지 말 것 — 그 사본과 이미지가 어긋난다.
- raw helm 이 Dex 값을 건드리면(비밀번호 회전) 가드가 없으므로 **곧바로 `sudo systemctl restart k3s`** (§5).
- `--reuse-values` 가 시크릿(enc key, pg pass, oidc)을 유지한다. 특정 값만 `--set` 으로 덮어씀.
  **데모 게이트도 유지된다** — 2026-09-09 rev 10 에서 `demo.allowTemplateCreate=false` 가 그대로
  남는 것을 확인했다. 완화 플래그가 재배포로 조용히 켜지지 않는다는 뜻이다.
- ⚠️ **`--reuse-values` 는 릴리스에 저장된 값만 이어받는다 — 그 뒤에 차트에 새로 생긴 키는 안 채운다.**
  `values-oci-phase2.yaml` 에만 있는 새 값은 이 명령으로 배포하면 **차트 기본값이 적용된다.**
  새 값이 들어간 버전을 올릴 때는 `--set` 으로 명시하거나 `helm get values kubeport -n kubeport`
  로 실제 머지된 값을 확인할 것. 현재 해당하는 것:

  ```
  --set demo.publicHealthCatalog=true
  ```

  이 값이 빠지면 `/healthz?verbose=1` 이 카탈로그 수를 내지 않고,
  `uptime-ping.yml` 이 10분 안에 "카탈로그 필드 없음" 으로 실패한다 — 데모가 멀쩡해도.
  그건 오탐이 아니라 설계된 신호다(감시가 꺼진 것을 감시가 알린다). 배포 직후 확인할 것.
- 롤아웃 직후 잠깐 `502` 가 날 수 있음(구 파드 종료↔신 파드 준비) — 30초 뒤 정상.

### 3-3. 배포 확인

먼저 ssh 없이:

```bash
curl -s https://kubeport.enzo.kr/api/healthz | jq -r .version    # → 배포한 sha 7자리
```

VM 쪽 상태(락·helm history·이미지 태그·chart 사본 sha)는 한 줄로:

```bash
ssh -i "$KEY" ubuntu@168.107.55.95 kubeport-deploy status
```

스크립트가 아직 설치되지 않은 VM 이면 예전 방식:

```bash
ssh -i "$KEY" ubuntu@168.107.55.95 \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   helm history kubeport -n kubeport | tail -3; \
   kubectl get deploy -n kubeport -o jsonpath='{range .items[*]}{.metadata.name}{\"\t\"}{.spec.template.spec.containers[0].image}{\"\n\"}{end}'"
```

`helm history` 의 최신 리비전이 `deployed` 이고 두 deployment 의 이미지 태그가 `$NEWSHA` 면 끝.

### 3-4. Dex 가 바뀌는 배포 (자동 거절 → 수동)

스크립트는 업그레이드 **전에** 지금 적용된 매니페스트(`helm get manifest`)와 새 렌더(`helm template`,
업그레이드와 똑같은 values·`--set`)에서 Dex 의 Deployment·ConfigMap·Secret 을 비교한다. 하나라도
다르면 Dex 파드가 재시작되고, 서명 키가 바뀌고, apiserver 의 JWKS 캐시 때문에 **데모 로그인은 되는데
클러스터 호출이 전부 401** 이 된다(§5, 2026-09-10 사고 — `/healthz` 는 초록). 워크플로는 k3s 재시작을
안전하게 할 수 없으므로 **아무것도 바꾸지 않고 exit 10** 으로 멈춘다.

잡히는 것: Dex 템플릿·`dex.*` 값의 변화, 그리고 **chart `version` bump** — 파드 템플릿 라벨
`helm.sh/chart` 에 들어가므로 실제로 Dex 가 재시작된다. 로그에는 바뀐 문서의 kind/이름만 찍히고 내용
(클라이언트 시크릿·비밀번호 해시)은 찍히지 않는다. 비교할 수 없으면(렌더 실패 등) 배포하지 않는다.

수동 절차 — **두 명령을 이어서**, 사이에 다른 일을 끼우지 않는다:

```bash
ssh -i "$KEY" ubuntu@168.107.55.95 kubeport-deploy deploy "$FULLSHA" --allow-dex-restart
ssh -i "$KEY" ubuntu@168.107.55.95 'sudo systemctl restart k3s && sleep 30 && sudo k3s kubectl get --raw=/readyz; echo; \
  START=$(systemctl show k3s -p ActiveEnterTimestamp --value); \
  sudo journalctl -u k3s --since "$START" --no-pager | grep -c "failed to verify id token signature"'
# → ok, 그리고 0. 이어서 데모 사용자로 로그인해 릴리스 상세가 인스턴스를 읽는지 본다.
```

- `--allow-dex-restart` 는 **관리자 키(argv 경로)에서만** 받는다. 배포 키의 forced command
  (`kubeport-deploy --forced`)로 오면 형식 거절(exit 2)이다 — 뒷단계(k3s 재시작)를 못 하는 쪽에 앞단계만
  허용하면 그 사고를 무인으로 재현한다.
- 가드는 "직전 적용본 대비" 비교라, 한 번 수동으로 올린 Dex 변경은 다음 커밋부터 차이가 아니다 —
  이후 main 커밋은 다시 자동으로 간다.

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

> **Dex 를 재시작했으면 k3s 도 재시작한다 — 선택이 아니다.**
>
> 데모 Dex chart 는 `storage: memory` 다. **Dex pod 가 재시작하면 서명 키가 새로 생긴다.**
> apiserver 는 issuer 의 JWKS 를 캐싱하므로, 새로 발급된 토큰조차 옛 키로 검증하려다 실패한다:
>
> ```
> k3s: "Unable to authenticate the request"
>   err="[invalid bearer token, oidc: verify token: failed to verify signature:
>        failed to verify id token signature]"
> backend: StreamReleaseLogs: list instances: Unauthorized
> ```
>
> **로그인은 되는데(Dex 가 발급) 클러스터 호출만 죽는다** — 릴리스가 전부 `cluster-unreachable`,
> 로그 탭이 `cluster-auth-denied`. `/healthz` 는 DB 만 보므로 **초록으로 남는다.**
>
> ```bash
> sudo systemctl restart k3s
> # 확인: 재시작 시각 이후로 잘라서 센다. "최근 N분" 은 재시작 전 로그가 섞인다.
> START=$(systemctl show k3s -p ActiveEnterTimestamp --value)
> sudo journalctl -u k3s --since "$START" --no-pager | grep -c 'failed to verify id token signature'
> ```
>
> 예전 이 문단은 "보통 자동으로 짧은 주기 뒤 해결된다" 고 적혀 있었다. **2026-09-10 에 50분
> 동안 해결되지 않았고, 그 문장이 조치를 미루게 만들었다.** 노드에서 JWKS 는 200 으로 잘
> 닿고 있었다 — 자동 갱신을 기다릴 근거로 삼지 말 것.

### 데모 모드 운영 (Plan 13, 2026-09-08 롤아웃 완료)

- **구성**: Helm revision ≥ 4 에 `dex.enabled=true` / `demo.enabled=true`, `demo.kubectlImage=alpine/k8s:1.31.9`.
  k3s 는 `/etc/rancher/k3s/auth.yaml` 로 Google + Dex 를 신뢰(`config.yaml.bak` 이 전환 전 백업).
- **데모 비밀번호 회전** — **2단계다(앞에 준비 0단계). 두 번째를 빼면 데모가 멈춘다.**
  0. **자동 배포와 겹치지 않게 한다.** `ssh -i "$KEY" ubuntu@168.107.55.95 kubeport-deploy status` 로 락이
     `free` 인지 본다(`HELD` 면 끝날 때까지 기다린다 — 런을 Cancel 하지 않는다, §3-0). 회전 중에 main 머지가
     있을 수 있으면 `gh workflow disable deploy.yml` — 1단계 직후 자동 배포가 락을 잡으면 2단계의 k3s 재시작이
     그 `helm upgrade` 한가운데에 떨어진다. **2단계와 확인까지 끝나면 `gh workflow enable deploy.yml`.**
  1. [deploy/oci/README.md §7.6](../deploy/oci/README.md) 의 `--set` 목록을 새 `DEMO_PW`/`HASH` 로
     다시 실행 (`staticPasswords[N]` 네 필드 전부, `--reset-then-reuse-values`, `flock` 락 포함 — 이미지
     태그는 올리지 않는다). `DEX_SECRET` 은 유지해도 된다.
  2. **`sudo systemctl restart k3s`.** 1 단계가 Dex pod 를 재시작시키고, Dex 는 `storage: memory`
     라 서명 키가 새로 생긴다. apiserver 의 JWKS 캐시를 비우지 않으면 **새 비밀번호로 로그인은
     되는데 클러스터 호출이 전부 401** 이다 (§5 위 주의 참조).

  회전 후 확인: 랜딩의 표기 값이 바뀌었는지, **옛 비밀번호로 로그인이 거부되는지**(거부돼야
  Dex 까지 실제로 도달한 것이다), 그리고 릴리스 상세가 인스턴스를 읽는지.
- **`demo.resetHostAliasIP` 는 OCI 에서 필수다.** 시더는 Dex 의 **공인** issuer URL 로 토큰을
  받는데, **파드는 이 인스턴스의 공인 주소로 나갈 수 없다.** 공인 IP 는 인터페이스에 없고
  (`ip addr` 에 `10.0.0.239` 만 보인다) OCI 엣지가 NAT 하므로, 파드 CIDR 에서 출발한 패킷은
  돌아오지 않는다 — `connect: no route to host`. **노드 자신은 같은 URL 에 200 으로 닿는다**
  (그래서 노드에서 `curl` 해 보고 정상이라 판단하면 오진한다).

  ```bash
  # 인그레스 주소 — 단일 노드면 노드 사설 IP
  kubectl get svc traefik -n kube-system -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
  # → helm upgrade ... --set demo.resetHostAliasIP=10.0.0.239
  ```

  호스트명은 그대로 두고 **해석만** 바꾸는 것이 요점이다. 요청이 같은 Host·SNI 를 들고 가니
  인증서가 맞고, `DEMO_OIDC_ISSUER` 도 안 바뀐다 — issuer 는 토큰의 `iss` 클레임과 대조되므로
  서비스 DNS 이름으로 바꾸면 그 대조가 깨진다.

  빠뜨렸을 때의 증상: 리셋 Job 이 `preflight` 에서 exit 1, `wipe-k8s` 는 실행되지 않음(#105 덕에
  아무것도 지워지지 않는다), 데모는 앞 상태 그대로 남고 **`/healthz` 는 초록**이다.
- **리셋**: CronJob `kubeport-demo-reset`, **하루 한 번 21:00 UTC = 06:00 KST**
  (`demo.resetSchedule`). 한국 시간 새벽이라 방문자 작업을 뺏을 확률이 가장 낮다. 6시간
  주기였을 때와 달리 **실패해도 몇 시간 뒤 자동 재시도가 없다** — 한 번 건너뛰면 이틀 공백이다
  ([#148](https://github.com/shyuni4u/kubeport/issues/148)). 수동 실행은 잡 이름을 매번 다르게 준다 —
  성공한 수동 잡은 CronJob 의 `successfulJobsHistoryLimit` 대상이 아니라 남으므로 고정 이름은
  두 번째 실행에서 `already exists` 로 실패한다:
  ```bash
  JOB=demo-reset-$(date +%s)
  kubectl -n kubeport create job --from=cronjob/kubeport-demo-reset "$JOB"
  kubectl -n kubeport logs "job/$JOB" -c seed -f    # 마지막 줄 `seed-demo: done`
  ```
  wipe 단계가 `demo` ns 의 configmap 을 전부 지우므로 `kube-root-ca.crt deleted` 가 찍히는 건 정상(자동 재생성).
- **오너 RBAC**: 오너 Google 이메일의 cluster-admin 바인딩 이름은 `kubeport-owner-admin`
  (예전 이름 `kubeport-demo-admin` 은 이름과 달리 오너 바인딩이었음 — 삭제 전 subject 확인).
  데모 계정은 chart 의 `demo` ns RoleBinding 만 갖는다. 검증: `kubectl auth can-i create deployments --as=dex:demo-user@demo.kubeport -n default` → **no**.
- **데모 계정의 템플릿 저작**: 기본은 **막혀 있다**(`POST /v1/templates` → 403 `demo-restricted`).
  데모 계정은 `kubeport-admin` 을 갖지만, 저작은 결과물이 방문자의 세션보다 오래 남고 남에게 보이는
  유일한 관리자 권한이라서다. 저작 체험까지 보여주려면 `--set demo.allowTemplateCreate=true`
  (backend `KBP_DEMO_ALLOW_TEMPLATE_CREATE`). 켜도 데모가 만든 템플릿은 실제 사용자 카탈로그에
  안 보이지만, 누군가 그걸로 배포하면 리셋이 그 템플릿을 건너뛴다(`tolerateFK`).
  결정 근거: [brainstorming-summary §14](brainstorming-summary.md).
  **리셋 CronJob 은 이 플래그와 무관하다** — 시드는 API 가 아니라 DB 로 직접 쓴다
  (`cmd/seed-demo/templates.go`). 한때 API 를 타서, 게이트가 닫힌 상태로 배포하자 리셋마다
  데모가 비워졌다([#104](https://github.com/shyuni4u/kubeport/issues/104)). 시드가 실패하면
  wipe 만 끝난 상태(빈 카탈로그)로 다음 리셋까지 방치되고 자동 알림은 없다. 배포 직후와 리셋 직후에 확인:
  ```bash
  kubectl -n kubeport get job -l app.kubernetes.io/instance=kubeport   # COMPLETIONS 1/1
  kubectl -n kubeport logs job/<최근 demo-reset 잡> -c seed | tail -5   # 마지막 줄 `seed-demo: done`
  ```
  `1/1` 이 아니거나 마지막 줄이 다르면 `-c seed` 로그의 첫 `log.Fatalf` 줄이 원인이다.
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

### Go API 를 직접 찔러 보기 (BFF 우회)

밖에서 보이는 것은 BFF(`/api/v1/...`) 뿐이고, BFF 는 세션 쿠키가 없으면 **401 을 먼저** 낸다.
그래서 Go API 의 404·405 같은 라우팅 동작은 밖에서는 확인할 수 없다 — 이건 결함이 아니라
설계다([docs/machine-clients.md §5](machine-clients.md#5-호출할-때-알아두면-좋은-것)).
예외는 `/api/v1` **루트**로, 세션 검사 없이 404 를 준다(#81). 그 아래 경로의 404·405 를
확인하려면 클러스터 안에서 서비스를 직접 잡는다:

```bash
ssh -i "$KEY" ubuntu@168.107.55.95 \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   kubectl port-forward -n kubeport svc/kubeport-backend 18080:8080 >/tmp/pf.log 2>&1 & \
   sleep 2; \
   curl -sS -i http://127.0.0.1:18080/v1/no-such-thing | head -5 || cat /tmp/pf.log; \
   kill %1"
```

출력이 통째로 비어 있으면 Go API 가 조용한 게 아니라 **터널이 안 선 것이다** — 이유는 `/tmp/pf.log`
에 있다(파드 미Ready, 포트 점유 등). `sleep` 을 늘리거나 파드 상태부터 본다.

⚠️ **`kubectl exec` 로 backend 파드에 들어가는 방법은 안 된다.** 이미지에 셸도 `wget` 도 없어서
`failed to exec in container` 로 끝난다. 파드 내부에서 뭔가 실행하려 하지 말고 위처럼
port-forward 로 밖에서 잡는다.

## 7. 자주 겪는 증상 → 원인

| 증상 | 확인 |
|---|---|
| 리셋 Job 이 `preflight: admin token: … no route to host` 로 실패 | 파드가 공인 주소로 못 나간다(OCI 엣지 NAT). `demo.resetHostAliasIP` 를 인그레스 주소로 설정 (§5). **노드에서 `curl` 하면 200 이라 정상으로 보인다** — 파드에서 확인할 것 |
| **로그인은 되는데** 릴리스가 전부 `cluster-unreachable` / 로그 탭이 `cluster-auth-denied` | Dex 를 재시작해 서명 키가 바뀌었고 apiserver 가 옛 JWKS 를 캐싱 중이다. `journalctl -u k3s | grep 'failed to verify id token signature'` 로 확인 → `sudo systemctl restart k3s` (§5). **`/healthz` 는 DB 만 보므로 이때도 초록이다** |
| `Identity file ... not accessible` → `Permission denied (publickey)` | 키 경로가 이 머신 것이 아니거나, **이 머신엔 아직 키 자체가 없다.** §1 "SSH 키 위치" 의 `ls` 로 둘 다 없으면 먼저 gpg 번들을 풀어야 한다 — 만든 머신은 `~/.ssh/oci_kuberport`, 번들로 복원한 머신은 `~/.ssh/kuberport-oci/oci_kuberport` |
| `helm`/`kubectl` 이 `Kubernetes cluster unreachable: ... localhost:8080` | ssh 명령에 `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml` 을 안 넣었다 (§3-2). `ssh <host> "<cmd>"` 는 프로필을 안 읽는다 |
| 배포할 `sha-<7>` 태그가 없다 | #122 이전 커밋이면 `push:` 쪽 `paths:` 필터에 걸려 이미지가 아예 안 만들어졌을 수 있다. `gh run list --workflow build-images.yml --branch main` 으로 확인 (§3-1). `--commit <sha>` 는 조용히 0건을 주고, `--limit` 이 작아도 0건이 된다 |
| 배포했는데 고친 게 라이브에 없다 (오류는 없음) | §3-1 에서 `git fetch` 를 빠뜨려 `origin/main` 이 옛 sha 였다. 그 sha 에도 이미지가 있어 전 단계가 다 초록으로 통과한다. `helm history` 의 태그와 `git rev-parse --short=7 origin/main` 을 fetch 후 대조 (§3-3) |
| deploy 워크플로가 `Refused: this deploy would restart Dex` (exit 10) | 결함이 아니라 가드다. 아무것도 바뀌지 않았다. §3-4 수동 절차 |
| deploy 워크플로가 `Refused: not forward of live` (exit 2) | 결함이 아니라 가드다. 배포 키는 라이브보다 옛 커밋으로 못 간다. 롤백이 목적이면 관리자 키로 `kubeport-deploy deploy <sha>` (§3-2) |
| `helm upgrade`/`rollback` 이 `another operation (install/upgrade/rollback) is in progress`, 또는 deploy 가 `aborted-before-upgrade` + `release kubeport is pending-upgrade` | 이전 helm 작업이 끝나지 못했다 — deploy 런 Cancel, ssh 끊김, VM 재부팅 중 upgrade. 락을 잡고 마지막 `deployed` 리비전으로 되돌린다: `ssh -i "$KEY" ubuntu@168.107.55.95 "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; helm history kubeport -n kubeport \| tail -5"` 로 `deployed` 인 rev 를 찾고 → `ssh ... "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; flock -w 600 /run/lock/kubeport-deploy.lock helm rollback kubeport <마지막 deployed rev> -n kubeport"`. 그 뒤 원래 하려던 배포를 다시 한다 |
| deploy 워크플로가 `SSH failed` (exit 255) | 인스턴스 stop/start 로 공인 IP 가 바뀌었다. `OCI_DEPLOY_HOST`·`OCI_DEPLOY_KNOWN_HOSTS` 시크릿 갱신 ([README "자동 배포 설치"](../deploy/oci/README.md#자동-배포-설치-github-actions--vm)) |
| deploy 워크플로가 `Version not live` | helm 은 끝났는데 `/api/healthz` 의 version 이 안 바뀐다. `kubeport-deploy status` 로 이미지 태그, 파드·ingress 확인 (§3-3). `version` 필드가 생기기 전 빌드를 배포한 거라면(관리자 키로 그 빌드까지 롤백한 뒤에만 가능) dispatch 에 `verify_version=false` |
| deploy 런이 `Skipped` notice 로 초록 | 그 사이 main 이 더 나아갔다. 새 커밋의 build-images → deploy 가 함께 올린다 (§3-0) |
| 새 파드가 `ImagePullBackOff` | 존재하지 않는 태그로 upgrade 했다. §3-1 로 태그부터 확인하고 `helm rollback kubeport <이전rev> -n kubeport` |
| backend 파드에 `kubectl exec` 이 `failed to exec in container` | 이미지에 셸이 없다. 정상이다 — port-forward 로 밖에서 잡는다 (§6 "Go API 를 직접 찔러 보기") |
| `/api/v1/<경로>` 가 404·405 대신 401 | 설계된 동작이다. BFF 세션 게이트가 라우팅보다 먼저다 ([machine-clients.md §5](machine-clients.md#5-호출할-때-알아두면-좋은-것)). `/api/v1` 루트만 예외로 세션 검사 없이 404 |
| 로그인 후 `redirect_uri_mismatch` | Google 콘솔 Authorized redirect URI 가 정확히 `https://kubeport.enzo.kr/api/auth/callback` 인지(`kubeport`↔`kuberport` 오타 주의 — 단 SSH 키 경로 `~/.ssh/kuberport-oci/` 는 실제 이름이라 그대로 둔다). authorize 는 되고 token 만 실패하면 콜백이 내부 host 로 redirect_uri 를 보낸 것 → `callback/route.ts` 가 `OIDC_REDIRECT_URI` 를 쓰는지 |
| 로그인 시 `invalid_scope` | `groups` scope. `oidc.scopes` 기본(`openid email profile`)이면 안 나야 함 |
| 배포가 조용히 실패 | pod→apiserver 차단(§5-2 iptables) 또는 사용자에 RBAC 바인딩 없음(§5-3) |
| 홈 `502` | 롤아웃 순간 일시적. 30초 뒤 재확인. 지속되면 파드 로그 |
| 좌측하단 클러스터 비어있음 | 등록 클러스터 0개 — §5-4. `kubectl exec ... psql -c "select name from clusters"` |
| 로그아웃을 누르면 "로그아웃하지 못했습니다. 아직 로그인된 상태입니다" 알림이 뜨고 화면이 그대로 | 거의 항상 로그아웃 라우트의 origin 검사 거부(403 `cross-origin request rejected`)다 — 서버 로그엔 안 남으니 브라우저 개발자도구 Network 탭의 `POST /api/auth/logout` 응답으로 확인한다. **다시 눌러도 안 풀린다.** 브라우저가 보는 origin 이 허용목록(§4)에 없는 것이므로, 도메인을 추가했거나 **TLS 를 클러스터 밖에서 종료하면서 `tls.enabled=false`** 로 뒀다면 `frontend.publicOrigins` 에 실제 https origin 을 넣고 `helm upgrade`. 응답이 403 이 아니라 네트워크 오류면 프록시 origin(§4) 을 본다. (#166 이전에는 실패해도 `/` 로 가서 성공처럼 보였다) |
| 로그인 후 `/` 로 되돌아오고 "로그인하지 못했습니다" 배너 | 콜백이 `?login_error=` 로 돌려보낸 것. 원인은 화면에 안 나오므로 `kubectl logs -n kubeport deploy/kubeport-frontend \| grep '\[auth/callback\]'` 확인. `cancelled` = 사용자가 동의화면에서 취소, `expired` = 10분 state 쿠키 만료, `failed` = IdP/DB 오류. 로그에 `suspicious=true` 면 state/nonce 불일치 — 콜백 위조·재생 시도일 수 있다 |
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
