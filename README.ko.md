# kubeport

[English](README.md) | **한국어**

> Kubernetes 를 위한 템플릿 기반 셀프서비스 포털.
> 관리자는 YAML + ui-spec 템플릿을 발행하고, 비전문 사용자는 추상화된 폼으로 배포·운영한다.

**상태:** <https://kubeport.enzo.kr> 에서 라이브 운영 중(OCI Always Free A1). 계정 없이 눌러볼 수 있는 데모 모드도 함께 열려 있다. 출시 완료: 관리자 템플릿 에디터, 카탈로그, RBAC 반영 배포 폼, 실시간 로그가 있는 릴리스 상세, DB↔클러스터 drift 회수, 그리고 스택 전체를 한 번에 올리는 Helm chart. 플랜별 진행 상황과 보류 항목은 [CLAUDE.md](CLAUDE.md) 참조.

---

## 데모를 체험하고 의견을 남겨주세요

**[데모 열기](https://kubeport.enzo.kr) · [피드백 남기기](https://github.com/shyuni4u/kubeport/issues/new) · [기존 이슈 보기](https://github.com/shyuni4u/kubeport/issues)**

초기 사용자 피드백을 받고 있습니다. 무엇을 하려 했는지, 어디서 막혔는지, 어떤 점을 바꾸면 편해질지 알려주세요. Kubernetes를 잘 몰라도 괜찮고, 버그가 아니어도 좋습니다. 이해하기 어려운 문구나 부족한 안내도 도움이 됩니다. 한국어·영어 모두 환영합니다.

### 짧게 체험하는 순서

1. 데모를 열고 **사용자로 체험**을 선택합니다. 첫 화면에 표시된 데모 계정과 비밀번호를 사용하면 됩니다. 개인 계정 가입은 필요하지 않습니다.
2. 카탈로그에서 **`web-app`**을 찾아 배포 폼을 엽니다. 설정 항목과 다음 행동을 이해할 수 있는지 살펴보세요.
3. 원한다면 **`demo`** 구역에 실제로 배포하고 상태와 로그를 확인합니다. 체험이 끝나면 직접 만든 릴리스만 삭제해주세요.
4. 망설였던 부분, 예상과 달랐던 동작, 오류를 알려주세요. 배포 전에 멈췄더라도 좋은 피드백입니다.

공개 데모는 여러 사람이 함께 쓰며, **매일 한국 시간 06:00(UTC 21:00)에 초기화**됩니다. 데모 권한 안에서 실제 배포가 가능하지만, 템플릿 버전 게시·팀 관리·클러스터 등록 같은 관리자 기능은 제한됩니다. 먼저 사용자 흐름을 체험해주세요. 직접 설치해서 사용하는 모든 상황을 데모에서 검증할 수는 없습니다.

### 이슈에는 무엇을 적으면 되나요?

기존 이슈에 같은 내용이 있다면 경험을 덧붙이고, 없다면 새 이슈를 열어주세요. 짧게 적어도 충분합니다. 아래 항목을 이슈 본문에 복사해 사용할 수 있습니다.

```text
사용 환경: 공개 데모 / 직접 설치
하려던 작업:
막힌 지점(화면과 진행 순서):
기대한 동작 / 실제 동작:
발생 시각(시간대 포함):
버전 또는 커밋(알고 있다면):
브라우저 / 기기(선택):
스크린샷(선택, 민감한 정보 제거):
```

**GitHub Issue는 공개됩니다.** 토큰·비밀번호·Secret·kubeconfig·민감한 입력값·민감한 정보를 지우지 않은 로그는 올리지 마세요. GitHub 사용이 번거롭다면 데모를 소개해준 사람에게 메시지로 전달해주세요. 이슈로 정리하는 데 도움을 받을 수 있습니다.

초기 피드백 수집(로드맵 14단계)은 약 2주간 직접 받은 의견과 GitHub Issue를 모으는 것으로 시작합니다. 매주 내용을 살펴보고 반복되는 문제와 작업을 막는 문제의 우선순위를 정한 뒤, 수정 PR과 해결 확인 결과를 이슈에 연결할 예정입니다. Sentry·Umami 연동은 이 피드백을 통해 자동 수집이 필요한 부분을 확인한 뒤 진행합니다.

## 왜 만드는가

Kubernetes 를 제대로 운영하려면 여전히 많은 양의 YAML 을 읽어야 한다. 기존 도구들은 각자 일부만 해결한다:

- `k9s` / `Lens` / `Headlamp` — 운영자에겐 훌륭하지만 k8s 지식을 전제로 한다.
- `Rancher` / `OpenShift` 템플릿 카탈로그 — 존재하지만 Helm 에 기대고, 여전히 리소스 수준 개념을 그대로 노출한다.
- `Backstage Software Templates` — 스캐폴딩은 되지만 일상 운영은 다루지 않는다.

`kubeport` 는 그 교집합을 채운다: 관리자가 템플릿을 한 번 작성하면, 팀원 누구나 `Pod` / `Deployment` / `replicas` 같은 필드를 보지 않고도 배포하고 관찰할 수 있다. **"Kubernetes 를 위한 Swagger"** 라고 생각하면 된다 — 하나의 스펙이 클러스터에서 실제로 돌아가는 매니페스트이자, 일반 사용자가 채우는 친근한 폼이 된다.

## 핵심 개념

**템플릿(template)** 은 두 개(선택적으로 세 개) 파일의 묶음이다. 한 쌍이 앱 DB 의 버전 관리되는 레코드 하나로 저장된다.

```
# resources.yaml  — 순수 Kubernetes YAML, placeholder 없음
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25

# ui-spec.yaml  — 어느 JSON 경로를 일반 사용자에게 노출할지
fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "컨테이너 이미지"
    type: string
```

`path` 의 세그먼트는 `[A-Za-z_][A-Za-z0-9_]*` 형태여야 한다. 라벨·애노테이션·ConfigMap 데이터 키처럼 그렇지 않은 키는 따옴표로 감싼다 — 점이 들어 있어도 키 하나로 취급된다: `Deployment[web].metadata.labels["app.kubernetes.io/name"]`. UI 모드 에디터는 자동으로 붙여 주고, ui-spec 을 손으로 쓸 때만 신경 쓰면 된다.

일반 사용자는 두 개의 필드(+ 릴리스 이름)만 있는 폼을 본다. `resources.yaml` 의 나머지는 전부 관리자가 고정한 값이다.

**릴리스(release)** 는 템플릿 버전 한 개를 특정 클러스터 + 네임스페이스에 배포한 인스턴스다. 릴리스는 템플릿 버전에 pin 된다(Helm / ArgoCD 방식). 관리자가 새 버전을 발행해도 동작 중인 릴리스는 계속 돌아가고, "업데이트 가능" 알림만 뜬다.

모든 템플릿에 걸리는 규칙이 몇 가지 있고, 어기면 API 가 거절한다:

- **이름** — RFC 1123 hostname 이면서 Kubernetes 라벨 값이어야 한다: 영문자·숫자, `-`·`.` 는 그 사이에만, 63자까지. 릴리스가 만드는 모든 오브젝트의 `kubeport.io/template` 라벨이 되기 때문이다. 이 규칙 이전에 만든 템플릿은 이름이 바뀌거나 다시 거절되지 않는다. 단 규칙을 어기는 이름은 원래도 배포 때 apiserver 가 거절했으므로, 그런 템플릿은 올바른 이름으로 다시 만든다.
- **오브젝트는 50개까지** — `resources.yaml` 기준으로 저장할 때와 배포할 때 모두 검사한다. 릴리스 적용이 네임스페이스 락을 쥐는 시간 안에 끝나야 해서다.
- **네임스페이스당 릴리스 하나 — ui-spec 이 `instances: multiple` 이 아니면.** multiple 이면 모든 오브젝트 이름이 `<릴리스>-<이름>` 이 되고, 템플릿 안의 참조가 새 이름을 따라가며, selector 가 릴리스까지 가려서 같은 템플릿을 나란히 여러 번 띄울 수 있다. 오브젝트 이름은 30자까지, `metadata.name` 은 노출할 수 없고, 버전을 게시하면 그 모드는 템플릿에 고정된다.
- **릴리스를 지우면 StatefulSet 이 만든 저장소도 지워진다.** `volumeClaimTemplates` 가 있는 StatefulSet 은 템플릿이 `Retain` 을 쓰지 않는 한 `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` 로 렌더된다. 네임스페이스에 이미 있는 PVC 를 넘겨받게 되는 배포는 409 로 거절된다.

## 아키텍처 한눈에

```
Browser ── Next.js (k8s Pod, BFF) ── Go API (in k8s) ── Target k8s clusters (N)
              │                         │
              ▼                         ▼
          Postgres                  (사용자 OIDC 토큰을 그대로 포워딩;
       (sessions + meta)             k8s RBAC 가 최종 판정자)
```

- **프론트엔드**: Next.js 16 (App Router), Tailwind + shadcn/ui, YAML 은 Monaco, 동적 폼은 React Hook Form + Zod. Go API 와 같은 Helm chart 안의 k8s `Deployment` 로 배포 — `helm install` 한 번으로 스택 전체가 올라간다.
- **백엔드**: Go 1.26+, Gin, `client-go`, `sqlc`, `atlas`, `coreos/go-oidc`.
- **데이터**: PostgreSQL 16 (로컬 개발은 docker compose 로 띄운다), OIDC + httpOnly 쿠키 세션, 리프레시 토큰은 저장 시 암호화.
- **보안 모델**: 앱은 UX 레이어일 뿐이다. 모든 k8s 쓰기는 로그인한 사용자의 OIDC id_token 으로 수행되므로, 실제 허용 여부는 Kubernetes RBAC 가 결정한다.

결정과 그 이유: [docs/brainstorming-summary.md](docs/brainstorming-summary.md). 네 화면의 설계: [프론트엔드 디자인 스펙](docs/superpowers/specs/2026-04-19-frontend-design-spec.md).

## 클러스터에 설치하기

자가호스팅은 Helm chart 하나면 된다:

```bash
git clone https://github.com/shyuni4u/kubeport && cd kubeport
helm install kubeport deploy/helm/kubeport --namespace kubeport --create-namespace \
  --set host=kubeport.example.com \
  --set ingress.className=nginx \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=$CLIENT_ID --set oidc.audience=$CLIENT_ID \
  --set-string auth.devAdminEmails=you@example.com \
  --set auth.oidcClientSecret=$CLIENT_SECRET \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set postgres.password=$(openssl rand -hex 24)
```

이 `--set` 시크릿은 셸 히스토리와 `ps` 에 남는다. 계속 쓸 설치본이라면 파일로 넘긴다:
[Keeping secrets off the command line](deploy/helm/kubeport/README.md#keeping-secrets-off-the-command-line).

`ingress.className` 은 클러스터에 맞는 값으로 바꾼다 — GKE `gce`, EKS `alb`,
nginx-ingress `nginx`, k3s `traefik`. 차트 기본값은 `traefik` 이다. traefik 이 없는
클러스터에서 기본값 그대로면 `no matches for kind "Middleware"` 로 **설치가 실패한다** —
차트의 http→https 리다이렉트가 Traefik 오브젝트라서다(#268). TLS 까지 끈 경우에는 에러가
전혀 안 난다: Ingress 는 만들어지지만 어떤 컨트롤러도 잡지 않아 주소가 계속 비어 있다.
어느 쪽이든 고칠 것은 CRD 가 아니라 class 다.

ingress-nginx 라면
`--set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size=4m'` 도
준다(작은따옴표가 셸로부터 역슬래시를 지켜, Helm 이 점을 애노테이션 이름의 일부로 읽는다).
kubeport 는 요청 본문을 4 MiB 까지 받는데 nginx 기본 한도는 1m 이라, 이 값이 없으면 1~4 MiB
사이의 템플릿·요청이 kubeport 에 닿기 전에 nginx 의 HTML 413 으로 거절된다. Traefik(k3s)은
기본 한도가 없다.

이 명령은 `latest` 태그를 설치한다. 계속 쓸 설치본이라면
`--set images.backend.tag=sha-<7> --set images.frontend.tag=sha-<7>` 를 붙인다 —
main 커밋마다 하나씩 발행되고, 핀해야 롤백이 가능하다.

TLS 는 cert-manager 가 맡는다. 차트는 **`letsencrypt-prod` 라는 ClusterIssuer** 를 가리키는
`Certificate` 를 만들지만, 그 issuer 자체는 만들지 않는다. 그 이름의 issuer 가 없으면
`helm install` 은 성공하고 파드도 전부 Ready 인데 **인증서만 끝내 발급되지 않아** 사이트에
유효한 TLS 가 없다. 드러나는 건 `kubectl -n kubeport get certificate` 의 `READY False` 뿐이다.
그러니 설치 전에 그 ClusterIssuer 를 만들거나(차트 README
[Quick install](deploy/helm/kubeport/README.md#quick-install-any-cluster) 의 2단계에 예시가 있다 —
solver 의 `class: traefik` 을 내 `ingress.className` 으로 바꿀 것. 그대로 두면 HTTP-01 챌린지를 아무도
받지 않아 똑같이 조용히 실패한다), 가진 것으로 차트를 돌린다:

- 다른 ClusterIssuer: `--set tls.certManager.issuerName=<이름>`
- 이미 있는 TLS Secret: `--set tls.certManager.enabled=false --set tls.existingSecret=<secret>`
- 클러스터 안에서 TLS 를 안 쓸 때: `--set tls.enabled=false --set tls.certManager.enabled=false`.
  이때 차트가 만드는 로그인·로그아웃 주소가 `http://` 가 된다. 클러스터 앞(로드밸런서,
  Cloudflare)에서 TLS 를 끝낸다면 브라우저가 보는 `https://` 주소를 차트에 알려 준다:
  `--set oidc.redirectUri=https://<host>/api/auth/callback`. 이 값은 IdP 에 등록한
  redirect URI 와 같아야 하고(다르면 IdP 가 로그인을 거절한다), `frontend.publicOrigins` 가
  비어 있으면 로그아웃이 검사하는 origin 도 이 값에서 나온다 — `http://` 로 두면 로그아웃이
  403 으로 거절된다.

먼저 [deploy/helm/kubeport/README.md](deploy/helm/kubeport/README.md) 를 읽는다 —
특히 **"After install — required on every cluster"**. 이 단계를 건너뛰면 앱은 뜨고
로그인도 되지만 **아무것도 배포하지 못한다.**

아래 "빠른 시작" 은 로컬 개발용이다.

## 빠른 시작

```bash
# 머신당 한 번, 0단계보다 먼저: dex 의 issuer URL 이 host.docker.internal 이라는 이름
# 그대로다. 따라서 이 이름이 이 호스트에서 127.0.0.1 로 풀려야 한다. Docker Desktop 이
# 이 항목을 머신의 LAN IP 로 미리 넣어 두는 경우가 많은데, 그러면 **이름은 풀리는데**
# 그 주소에 dex 가 없어서 계속 실패한다.
grep -i host.docker.internal /etc/hosts    # Windows: C:\Windows\System32\drivers\etc\hosts
# 정확히 이 한 줄이어야 한다: 127.0.0.1 host.docker.internal
# 다른 주소로 잡힌 항목은 지운다. 전체 절차: docs/local-e2e.md §1

# 0. dex 가 TLS 로 쓸 인증서 생성. 클론당 한 번 — 이 파일들은 gitignore 대상이라
#    새로 클론하면 없고, 없으면 dex 가
#    "open /config/certs/dex.crt: no such file or directory" 로 죽는다.
#    (k8s 1.30+ 가 http:// OIDC issuer 를 거부해서 로컬에서도 dex 는 TLS 로 뜬다.)
cd deploy/docker/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout dex.key -out dex.crt -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1"
chmod 644 dex.key      # dex 컨테이너가 비루트로 읽어서 600 이면 안 뜬다. 644 가 안전한
                       # 이유는 이게 폐기용 쌍이기 때문이다 — 아래 3단계가 dex.crt 를 CA 로
                       # 신뢰하므로, 공용 머신이라면 이 키를 읽을 수 있는 사람은 당신의
                       # 로컬 IdP 를 사칭할 수 있다. 이 compose 밖으로 재사용 금지.
cd -
# Windows Git Bash 라면 위 openssl 줄 앞에 MSYS_NO_PATHCONV=1 을 붙인다. MSYS 가
# -subj 의 맨 앞 슬래시를 파일 경로로 바꿔 버려서 openssl 이 거부한다
# ("This name is not in that format: 'C:/Program Files/Git/CN=...'").

# 1. 로컬 Postgres + dex (OIDC) 띄우기
docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml ps    # 둘 다 Up (healthy) 여야 한다

# 2. DB 스키마 적용 (atlas.hcl 은 backend/migrations 에 있음)
cd backend/migrations && atlas schema apply --env local --auto-approve && cd ..

# 3. Go API 실행. env 가 필요하다 — 아무것도 안 주면
#    "OIDC config: set KBP_OIDC_ISSUERS or both OIDC_ISSUER and OIDC_AUDIENCE" 로
#    즉시 종료한다. 전체 목록과 각 값의 의미는 docs/local-e2e.md §7.
LISTEN_ADDR=:8080 \
  DATABASE_URL='postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable' \
  OIDC_ISSUER=https://host.docker.internal:5556 \
  OIDC_AUDIENCE=kubeport \
  OIDC_CA_FILE="$PWD/../deploy/docker/certs/dex.crt" \
  APP_ENCRYPTION_KEY_B64="$KBP_KEY" \
  KBP_DEV_ADMIN_EMAILS=admin@example.com \
  go run ./cmd/server
# $KBP_KEY: `export KBP_KEY=$(openssl rand -base64 32)` 로 한 번 만들고 4단계에서 같은
# 값을 쓴다. 프론트엔드가 이 키로 세션 토큰을 암호화하고 백엔드도 같은 키로 설정되므로,
# 값이 다르면 로그인할 때마다 한쪽이 쓴 것을 다른 쪽이 못 읽는다.
# ↑ 로컬 전용: 그룹 검사 없이 이메일만으로 앱 관리자로 격상한다. 이 변수는 프로덕션에서도
#   똑같이 동작한다. 절대 프로덕션에 넣지 말 것.
#
# 기동 로그의 "discovery failed ... (will retry on first use)" 는 dex 가 아직 안 떴을
# 때도 나고, 위 hosts 항목이 틀렸으면 영원히 난다. **/healthz 로는 구분할 수 없다** —
# DB 와 리스너만 보므로 어느 쪽이든 200 이다. dex 에 직접 물어라:
#   curl -ks -o /dev/null -w '%{http_code}\n' \
#     https://host.docker.internal:5556/.well-known/openid-configuration
# 200 이면 정상. 000 이면 그 이름이 dex 가 없는 곳으로 풀린 것이고, 백엔드 로그가
# 무슨 말을 하든 로그인은 되지 않는다.

# 4. 웹 앱 실행 (다른 터미널에서). frontend/.env.local 은 gitignore 대상이고 복사할
#    예시 파일도 없으니 직접 만든다. 모든 값의 의미가 붙은 전체 블록은
#    docs/local-e2e.md §8. 이 빠른 시작에 필요한 최소값:
cd ../frontend
cat > .env.local <<EOF
GO_API_BASE_URL=http://localhost:8080
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=$KBP_KEY
OIDC_ISSUER=https://host.docker.internal:5556
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
EOF
pnpm install
# NODE_EXTRA_CA_CERTS 는 선택이 아니다. openid-client 가 0단계의 자체서명 dex 인증서를
# 신뢰해야 하고, 없으면 로그인 콜백이 인증서 검증에서 실패한다 — 원인을 알려 주는
# 메시지 없이.
NODE_EXTRA_CA_CERTS="$PWD/../deploy/docker/certs/dex.crt" pnpm dev

# 5. http://localhost:3000 접속, alice / alice 로 로그인
```

`scripts/e2e/up.sh` 가 이 `.env.local` 을 만들어 주긴 하지만 kind 클러스터까지 세우고
인증서도 발급한다 — 그건 e2e 경로다. 스택 전체가 필요할 때 쓰고([docs/local-e2e.md §0](docs/local-e2e.md)),
4단계를 건너뛰는 지름길로 쓰지 않는다.

브라우저 → kind 배포까지 가는 전체 로컬 셋업(자체서명 dex cert, Windows hosts 함정, OIDC 일관성 등)은 [docs/local-e2e.md](docs/local-e2e.md) 참조. 위의 "빠른 시작"은 백엔드+프런트+DB 까지만 충분하고, 실제 k8s 클러스터 e2e 는 몇 단계가 더 필요하다.

## 테스트 실행

```bash
# Unit + integration (compose 기동 상태 필요 — 테스트가 그 Postgres 와 dex 를 쓴다)
(cd backend && go test -p 1 ./...)
# -p 1: 패키지들이 공유 테스트 DB 를 이름 패턴으로 정리해서, 병렬이면 서로의 행을 지운다.
# `make test` 는 -p 1 없이 같은 것을 돈다.

# 백엔드 End-to-end (kind 클러스터 필요 — docs/local-e2e.md 참조)
export KBP_KIND_API=https://127.0.0.1:6443
make e2e
```

브라우저 e2e(compose + kind 위의 Playwright)는 스크립트가 따로 있다:
[docs/local-e2e.md §0](docs/local-e2e.md). 테스트 레이어·사전 조건·세션별 테스트 DB 는
[docs/testing.md](docs/testing.md).

## 필수 도구

- Docker (로컬 Postgres + dex)
- Go 1.26+
- Node 20.9+ (Next 16 의 engines 하한 — CI·이미지는 24 로 돈다), pnpm 10+
- [`atlas`](https://atlasgo.io) CLI, `sqlc`
- `openssl` (0단계 dex 인증서 + 위 설치 명령의 시크릿 생성)
- (설치 전용) [`helm`](https://helm.sh) 3.x — 차트 스냅샷을 재생성할 거라면 CI 와
  같은 **v3.20.2** 로 고정한다. helm 4 는 문서 구분자 앞에 빈 줄을 하나 더 넣어서,
  helm 4 로 갱신한 스냅샷은 내가 만들지도 않은 diff 로 CI 를 깨뜨린다.
- `kubectl` — 테스트 전용이 아니라 **모든 설치**에 필요하다. 차트 README 의
  "After install" 단계와 아래 port-forward 가 전부 kubectl 이다
- (e2e + 아래 "Try it first" 경로) [`kind`](https://kind.sigs.k8s.io) —
  `scripts/e2e/up.sh` 가 쓰고 `scripts/e2e/doctor.sh` 도 검사한다
- `make` — `make test` · `make e2e` · 차트의 `make helm-snapshot` 이 전부 이걸 쓴다.
  Ubuntu/WSL 기본 이미지에는 없다

"클러스터에 설치하기" 는 대상 클러스터에 Ingress 컨트롤러와 cert-manager 가 추가로
필요하다. 둘 다 없이 그냥 띄워 보고 싶으면 차트 README 의
[Ingress·cert-manager 없는 경로](deploy/helm/kubeport/README.md#try-it-first-any-cluster-no-ingress-no-cert-manager)를 쓴다.

OS 별 설치 절차와 Windows 경로 함정은 [docs/dev-setup.md](docs/dev-setup.md).

## 현황과 로드맵

플랜별로 무엇이 출시됐고 무엇이 보류인지는 [CLAUDE.md](CLAUDE.md) 의 플랜 표에서, 진행 중인 일은
이슈 트래커에서 본다. 지금 보류 중인 것: CRD 지원, Git 연동 템플릿, Helm chart 임포트, 릴리스
히스토리, 클러스터 drift 를 감시하는 백그라운드 reconciler(지금은 릴리스를 읽을 때 drift 를 판정한다).

## 디렉터리 구조

```
kubeport/
├── backend/                          # Go API
├── frontend/                         # Next.js BFF + UI
├── deploy/docker/                    # 로컬 compose (Postgres + dex)
├── deploy/helm/                      # Helm chart (운영 설치용)
├── deploy/oci/                       # 라이브 설치본의 부트스트랩·배포 스크립트
├── scripts/                          # 로컬 e2e·compose·테스트 DB 도우미
├── docs/
│   ├── superpowers/specs/            # 지금도 쓰는 디자인 스펙
│   ├── decisions/                    # ADR (필요 시 추가)
│   ├── oci-prod-runbook.md           # 라이브 설치본 운영
│   └── brainstorming-summary.md      # 결정의 근거
├── CLAUDE.md                         # Claude Code 세션 진입점
└── README.md
```

## 컨텍스트 빠르게 찾기

- **뭐라도 만들고 싶다** → [CLAUDE.md](CLAUDE.md) 읽고, 열린 이슈로.
- **특정 결정의 이유가 궁금하다** → [docs/brainstorming-summary.md](docs/brainstorming-summary.md).
- **시스템 전체 그림을 보고 싶다** → [CLAUDE.md](CLAUDE.md) 의 기술 스택·아키텍처 경계, 그리고 [프론트엔드 디자인 스펙](docs/superpowers/specs/2026-04-19-frontend-design-spec.md).
- **로컬에서 돌려보고 싶다** → 위의 "빠른 시작".
- **AI로 내 설치본을 사용하고 싶다 (Beta)** → [Skill + CLI 연결](docs/ai-client.md). 별도 MCP 서버나 중앙 인증 서비스 없이 자기 설치본에 연결한다.
- **스크립트로 API 를 호출하고 싶다** → 계약은 [backend/api/openapi.yaml](backend/api/openapi.yaml), 인증 방법은 [docs/machine-clients.md](docs/machine-clients.md).

## 기여

아직 외부 기여는 받지 않는다 — 시스템의 모양이 아직 안정화 중이다. 버그 리포트 이슈는 지금도 환영한다.

## 라이선스

[MIT License](LICENSE) — 자유롭게 사용·수정·재배포 가능. 저작권 표기와 라이선스 전문만 유지하면 된다.
