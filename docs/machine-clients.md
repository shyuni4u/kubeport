# 스크립트·에이전트에서 kubeport API 호출하기

사람이 브라우저로 쓰는 것 말고, **스크립트나 AI 에이전트가** kubeport 를 조작하려 할 때 필요한 것들.
API 계약 자체는 [`backend/api/openapi.yaml`](../backend/api/openapi.yaml) 에 있고, 이 문서는 **어디로
어떻게 붙느냐**만 다룬다.

> **요약을 먼저:** 로컬 개발 환경에서는 dex 의 password grant 로 토큰을 얻어 바로 호출할 수 있다(§2, 검증됨).
> **운영 환경에서 실사용자 권한으로 쓸 비대화형 경로는 아직 없다**(§3) — 데모 dex 를 통한 데모 범위
> 자동화만 가능하다. 클러스터 등록 같은 운영자 1회성 작업은 §4 의 우회 경로를 쓴다. 장기 해법은
> [issue #34](https://github.com/shyuni4u/kubeport/issues/34).

---

## 1. 입구가 두 개다 — 어느 쪽에 붙는지부터 정한다

| | Go API | Next.js BFF |
|---|---|---|
| 주소 | `http://<backend>:8080` | `https://<host>/api` |
| 외부 노출 | **없음.** `ClusterIP` 이고 Ingress 는 모든 외부 경로를 프론트로 보낸다 | 있음 |
| 인증 | `Authorization: Bearer <id_token>` | **httpOnly 세션 쿠키** |
| 경로·본문 | `openapi.yaml` 그대로 | `/api` 접두어만 붙고 나머지 동일 |

**BFF 는 요청의 `Authorization` 헤더를 무시한다.** 세션 쿠키에서 토큰을 꺼내 서버 측에서 새로 붙인다
(`frontend/app/api/v1/[...path]/route.ts`). 그래서 베어러 토큰을 들고 `https://<host>/api/v1/...` 을
호출하는 건 동작하지 않는다 — 토큰이 있다면 Go API 쪽에 직접 붙어야 한다.

Go API 는 클러스터 밖에서 안 보이므로 port-forward 로 연다:

```bash
# Service 이름은 릴리스 이름에 따라 달라진다 (myrel → myrel-kubeport-backend). 라벨로 찾는다:
BACKEND_SVC=$(kubectl -n kubeport get svc \
  -l app.kubernetes.io/name=kubeport,app.kubernetes.io/component=backend \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n kubeport port-forward "svc/$BACKEND_SVC" 8080:8080 &
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/me
```

`GET /v1/me` 는 토큰이 살아 있는지, 그리고 내가 관리자인지(`groups` 에 `kubeport-admin`) 확인하는
가장 싼 방법이다.

---

## 2. 로컬 개발 — dex password grant (검증됨)

**먼저 dex 가 떠 있어야 한다.** 새로 클론하면 `deploy/docker/certs/` 는 비어 있고(인증서는 gitignore
대상), dex 는 TLS 인증서가 없으면 `loading TLS keypair: no such file or directory` 로 즉시 죽는다.

```bash
# 한 번만 — 자가서명 인증서 (docs/local-e2e.md §2 와 같은 명령)
cd deploy/docker/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout dex.key -out dex.crt \
  -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1"
cd -

docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml ps   # dex 가 Up 인지 확인
```

(`scripts/e2e/up.sh` 가 이 두 단계를 대신 해 준다.)

그 다음 password grant 로 토큰을 받는다 — 브라우저가 필요 없다.

```bash
curl -ks -X POST https://host.docker.internal:5556/token \
  -d grant_type=password \
  -d client_id=kubeport -d client_secret=local-dev-secret \
  -d username=admin@example.com -d password=admin \
  -d 'scope=openid email profile' \
  | jq -r .id_token
```

계정은 `deploy/docker/dex.yaml` 의 `staticPasswords` 에 있다 (`alice/alice`, `admin/admin`,
데모 계정 2개는 비밀번호 `demo`).

**2026-09-09 확인 결과** — 리포의 `deploy/docker/docker-compose.yml` 스택이 돌려주는 id_token 클레임:

```json
{
  "iss": "https://host.docker.internal:5556",
  "sub": "CglhZG1pbi0wMDASBWxvY2Fs",
  "aud": "kubeport",
  "email": "admin@example.com",
  "email_verified": true,
  "name": "admin"
}
```

여기서 세 가지가 중요하다.

- **`iss` 는 `dex.yaml` 의 `issuer` 와 문자열까지 같아야 한다.** 백엔드 `OIDC_ISSUER`, 차트
  `oidc.issuer`, 클러스터의 `oidc_issuer_url` 을 전부 이 값으로 맞춘다. 포트를 다르게 매핑한
  dex 로 토큰을 받아 놓고 issuer 를 안 맞추면 401 이 나는데, 원인을 찾기 어렵다.

- **`groups` 클레임이 없다.** `scope` 에 `groups` 를 넣어도 안 나온다 — 이 static password 들에
  `groups` 가 설정돼 있지 않기 때문이다. 그래서 **로컬에서 관리자가 되는 경로는 groups 가 아니라
  `KBP_DEV_ADMIN_EMAILS` 다.** 백엔드를 띄울 때 그 env 에 이메일을 넣어야 `POST /v1/clusters` 같은
  admin 전용 엔드포인트가 열린다.
- **`aud` 가 `kubeport`** 라서 차트 기본값 `oidc.audience: kubeport` 와 그대로 맞는다. Google 은
  `aud` 가 client_id 라 이 기본값을 그대로 두면 모든 로그인이 401 이 된다
  ([#54](https://github.com/shyuni4u/kubeport/issues/54)).

전체 로컬 스택을 세우는 순서는 [docs/local-e2e.md §0](local-e2e.md) 참조. §9 에 이 토큰으로 클러스터를
등록하고 템플릿을 시드하는 실제 예시가 있다.

---

## 3. 운영 환경 — 실사용자 권한으로는 경로가 없다

운영 설치는 IdP 가 **둘**이다: 주 IdP 인 Google(`values.yaml` 의 `oidc.issuer`)과, 데모 모드를 켰다면
자체 호스팅 dex. 둘을 구분해야 답이 정확해진다.

**Google 쪽 — 경로 없음.**

- **password grant 를 지원하지 않는다.** §2 방식이 통하지 않는다.
- **`client_credentials` 는 이 리포 어디에도 구현돼 있지 않다.** 백엔드는 `requireAuth` 에서 오직
  id_token 만 검증한다(`backend/internal/api/middleware.go`).
- **브라우저 세션에서 토큰을 꺼낼 수 없다.** 세션 쿠키는 httpOnly 라 JS 로 못 읽고, 애초에 쿠키 안에
  토큰이 없다 — 서버 측 DB 에 암호화되어 저장된다(`sessions` 테이블).

**데모 dex 쪽 — 경로는 있지만 데모 권한까지만.** `dex.enabled` 인 설치에서는 dex 가
`passwordConnector: local` + `enablePasswordDB: true` 로 배포되고(`templates/dex-configmap.yaml`)
`dex.host` 로 공인 Ingress 에 노출된다(`templates/dex-ingress.yaml`). 즉 §2 와 **같은 password grant 가
운영에서도 통한다.** 다만 쓸모가 제한된다:

- `dex.clientSecret` 이 필요하다 — 클러스터 Secret 이라 `kubectl` 을 가진 사람만 얻는다.
- 얻은 신원은 데모 도메인이라 `denyDemo` 가 걸린 라우트(`POST /v1/clusters`, `POST /v1/teams`,
  팀 멤버 추가·삭제)에서 **403 `demo-restricted`** 다.
- k8s 쪽 권한도 `demo` 네임스페이스로 묶여 있다(`templates/demo-rbac.yaml`).

그래서 **데모 범위의 스모크 자동화는 가능하고, 실사용자 권한으로 운영을 자동화하는 경로는 여전히
없다.** 후자가 [issue #34](https://github.com/shyuni4u/kubeport/issues/34) 의 내용이고, 후보 해법 두 가지는:

1. **서비스 계정 토큰(장수명 API key)을 `/v1` 에 도입** — `Authorization: Bearer kbp_...` 를
   `requireAuth` 가 함께 받도록. 다만 kubeport 의 보안 모델은 "사용자 토큰을 k8s 로 그대로 포워딩"
   이라, 서비스 계정은 **k8s 쪽 신원도 함께 정해야** 한다. 단순한 추가가 아니다.
2. **IdP 쪽에서 서비스 계정 발급** — Google 서비스 계정으로 대상 audience 의 id_token 을 받는 방식.
   이 경우 그 서비스 계정 이메일에 대해 k8s RBAC 바인딩도 별도로 걸어야 한다.

둘 다 설계 결정이 필요하므로 여기서 임의로 안내하지 않는다.

---

## 4. 운영자 1회성 작업 — 클러스터 등록

설치 직후 대상 클러스터를 등록하는 건 §3 의 공백에도 불구하고 지금 해야 하는 일이다. 두 가지 경로가 있고,
**어느 쪽이든 `ca_bundle` 을 반드시 채운다** — 비우면 백엔드가 그 클러스터에 대해 TLS 검증을 끈 채로
접속하고(`backend/cmd/server/main.go` 의 `k8sFactory.NewWithToken` → `NewInsecureWithToken`),
**그 연결로 사용자 id_token 이 그대로 나간다.** 등록은 201 로 성공하므로 응답만 봐서는 알 수 없다.

k3s 라면 값은 `/var/lib/rancher/k3s/server/tls/server-ca.crt` 의 내용(PEM 원문, base64 아님).

**A. DB 에 직접 insert.** `deploy/oci/README.md` §7.4 가 허용하는 방식이다. 클러스터 접속 정보는
인프라 설정이지 PII 가 아니므로 이 경로가 정당하고, 토큰이 필요 없어서 §3 의 공백을 우회한다.

```bash
# 차트 내장 Postgres 기준. 외부 DB 면 psql 접속만 바꾼다.
PG_POD=$(kubectl -n kubeport get pod \
  -l app.kubernetes.io/name=kubeport,app.kubernetes.io/component=postgres \
  -o jsonpath='{.items[0].metadata.name}')

CA=$(sudo cat /var/lib/rancher/k3s/server/tls/server-ca.crt)   # k3s 기준

kubectl -n kubeport exec -i "$PG_POD" -- psql -U kubeport -d kubeport <<SQL
INSERT INTO clusters (name, display_name, api_url, ca_bundle, oidc_issuer_url, default_namespace)
VALUES ('oci-a1', 'OCI A1', 'https://kubernetes.default.svc',
        \$ca\$${CA}\$ca\$, 'https://accounts.google.com', 'default');
SQL
```

컬럼 목록의 근거는 `backend/internal/store/clusters.sql.go` 의 `InsertCluster` 다 — 스키마가 바뀌면
거기부터 확인한다. `ca_bundle` 을 빼먹지 말 것: 위 경고가 그대로 적용된다.

**B. port-forward + 토큰.** 토큰을 어떻게든 손에 넣었다면:

```bash
# Service 이름은 릴리스 이름에 따라 달라진다 (myrel → myrel-kubeport-backend). 라벨로 찾는다:
BACKEND_SVC=$(kubectl -n kubeport get svc \
  -l app.kubernetes.io/name=kubeport,app.kubernetes.io/component=backend \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n kubeport port-forward "svc/$BACKEND_SVC" 8080:8080 &

curl -sS -X POST http://localhost:8080/v1/clusters \
  -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
  -H 'content-type: application/json' -d '{
    "name": "oci-a1",
    "api_url": "https://kubernetes.default.svc",
    "ca_bundle": "-----BEGIN CERTIFICATE-----\n...",
    "oidc_issuer_url": "https://accounts.google.com",
    "default_namespace": "default"
  }'
```

`name` 은 **필수**이고 `ca_bundle` 은 스키마상 선택이지만 위 경고대로 실질 필수다. 필드 표 전체는
`openapi.yaml` 의 `CreateClusterRequest` 참조.

### 관리자 판정 — 그리고 그 방식의 문제

위 호출은 admin 전용이라, 호출자가 `kubeport-admin` 그룹에 있어야 한다. Google 은 `groups` 클레임을
발급하지 않으므로 실제로는 `KBP_DEV_ADMIN_EMAILS`(차트의 `auth.devAdminEmails`)에 이메일을 넣는 것이
**현재 유일한 방법**이다. 안 하면 `403 admin group required`.

```bash
helm upgrade kubeport deploy/helm/kubeport --reuse-values \
  --set-string auth.devAdminEmails="you@example.com"
```

같은 내용이 [deploy/oci/README.md §4](../deploy/oci/README.md) 에도 있다 (`auth.devAdminEmails` 설명).

다만 이건 **정식 역할 시스템이 아니라 부트스트랩 우회**라는 걸 알고 써야 한다:

- 백엔드는 이 값이 설정되면 기동 시 경고를 남긴다 — `backend/cmd/server/main.go`:
  `"WARN: KBP_DEV_ADMIN_EMAILS is set, elevating %q to kubeport-admin — dev only, never set in production"`.
  즉 **코드의 의도와 실제 운영 방식이 어긋나 있다**(운영은 이 값에 의존한다).
- 데모 모드를 켜면 차트가 **공개 데모 관리자 이메일을 이 목록에 자동으로 덧붙인다**
  (`deploy/helm/kubeport/templates/_helpers.tpl` 의 `kubeport.devAdminEmails`). 비밀번호가 랜딩에
  공개된 계정이 in-app admin 이 된다는 뜻이므로, 권한 설계를 할 때 이 사실을 전제해야 한다.

그래서 목록은 최소 인원으로 유지하고, groups 를 발급하는 IdP(Keycloak/Okta/Dex)로 옮길 수 있으면
옮긴 뒤 비운다.

---

## 5. 호출할 때 알아두면 좋은 것

**에러는 전부 한 가지 형태다.** `Problem{type,title,status,detail}`. 분기는 `title` 로 한다 —
값의 닫힌 목록은 `openapi.yaml` 의 `ErrorKind` enum 에 있고, 새 kind 가 몰래 생기면
`backend/internal/api/error_shape_test.go` 가 빌드를 깬다. `detail` 은 사람이 읽는 문장이라 바뀔 수 있다.

**비인증 호출은 JSON 401 이다 — 단, [#24](https://github.com/shyuni4u/kubeport/issues/24) 수정이 배포된
리비전부터.** 그 이전 리비전의 BFF 는 `/api/auth/login` 으로 **307** 을 보낸다.

```json
{"type":"https://kubeport.io/errors/unauthenticated","title":"unauthenticated","status":401,"detail":"..."}
```

어느 쪽을 만나든 **리다이렉트를 따라가지 않는 게 맞다** (`curl` 에 `-L` 금지). 307 을 따라가면 Google
동의 화면이 `200` 으로 떨어져서 순진한 클라이언트가 성공으로 오인한다. 2xx 가 아닌 응답은 전부 실패로
처리할 것.

**배포 전에 두 번 물어볼 수 있다.** 값이 맞는지는 `POST /v1/templates/{name}/render`(적용 없이 렌더만),
권한이 있는지는 `POST /v1/selfsubjectaccessreview`. 둘 다 부작용이 없으니 실패를 겪기 전에 쓰는 게 낫다.

**201 은 "적용을 접수했다"는 뜻이지 "떴다"가 아니다.** 상태는 `GET /v1/releases/{id}` 의 `status` 로
확인한다. 그 값은 요청 시점에 클러스터를 조회해 만드는 파생값이라 저장돼 있지 않고, 따라서 "여기서 끝"
이라고 볼 종료 상태가 없다. 목록(`GET /v1/releases`)에는 status 가 아예 없어서 N개 릴리스를 폴링하면
클러스터 왕복도 N번이다 ([#57](https://github.com/shyuni4u/kubeport/issues/57),
[#58](https://github.com/shyuni4u/kubeport/issues/58)).

**목록은 페이지네이션 메타가 없다.** `total` 도 `next` 도 없어서 "다음 페이지가 있나"는 한 페이지가 꽉
찼는지로 추측해야 한다. 템플릿 목록은 아예 페이지네이션이 없다(#58).

---

## 관련

- [`backend/api/openapi.yaml`](../backend/api/openapi.yaml) — API 계약
- [docs/local-e2e.md](local-e2e.md) — 로컬 스택 전체 세우기
- [deploy/helm/kubeport/README.md](../deploy/helm/kubeport/README.md) — 설치와 설치 후 필수 단계
- [#34](https://github.com/shyuni4u/kubeport/issues/34) 비대화형 토큰 ·
  [#25](https://github.com/shyuni4u/kubeport/issues/25) MCP 서버
