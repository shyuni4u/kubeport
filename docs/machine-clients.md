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
- 얻은 신원은 데모 도메인이라 다음에서 **403 `demo-restricted`** 다: 항상 막히는 관리 쓰기(`POST /v1/clusters`,
  `POST /v1/clusters/:name/openapi/refresh`, `POST /v1/teams`, 팀 멤버 추가·삭제, `DELETE /v1/releases/:id?force=true`),
  설치가 `demo.allowTemplateCreate=true` 를 켜지 않았을 때의 `POST /v1/templates`, 그리고 데모 계정이 만들지 않은
  릴리스의 읽기·변경.
- 데모 계정이 만들지 않은 템플릿은 **읽기도 배포도 403 이 아니라 404 `not-found`** 다 — `GET /v1/templates/:name`·
  `/versions`·`/versions/:v`, `POST /v1/templates/:name/render`, `POST /v1/releases` 모두 없는 템플릿·버전과 같은
  응답이다([#226](https://github.com/shyuni4u/kubeport/issues/226), [#238](https://github.com/shyuni4u/kubeport/issues/238)).
  **변경 경로**(`PATCH /v1/templates/:name`, 버전 생성·수정·삭제, publish·deprecate·undeprecate)도 같은 404 다
  ([#244](https://github.com/shyuni4u/kubeport/issues/244)). 템플릿 목록이 숨기는 것과 같은 선이라, 이름을 알아도 내용을
  받거나 존재를 확인할 수 없다(아예 없는 이름과 status·title·detail 이 같다). 반대 방향도 같다: 관리자가 아닌 실사용자에게
  데모 템플릿은 없는 것으로 보인다. 선 밖에서도, **한 번도 게시되지 않은** 템플릿의 초안을 읽을 권한이 없으면 읽기든 변경이든
  403 이 아니라 404 다. 사유가 담긴 403 은 **볼 수는 있지만 바꿀 수 없는** 템플릿에만 온다 — 게시된 템플릿(이름이 이미
  카탈로그에 공개돼 있다)의 변경이나 이후 초안 읽기, 팀 viewer 의 변경. 팀 역할은 이 선을 넘지 않는다 — 운영자 팀에
  들어간 데모 계정도 그 팀 템플릿을 읽을 수도 바꿀 수도 없다. **알려진 한계**: 템플릿 이름은 설치 전체에서 유일해서,
  `POST /v1/templates` 의 409 `conflict` 는 볼 수 없는 템플릿 이름과도 충돌한다.
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
**어느 쪽이든 `ca_bundle` 을 반드시 채운다.**

`POST /v1/clusters` 는 이제 `ca_bundle` 을 PEM 으로 검증하고, 비었거나 파싱되지 않으면 **400** 이다
([#96](https://github.com/shyuni4u/kubeport/issues/96)). 예전에는 선택 항목이라 비우면 백엔드가 그
클러스터에 TLS 검증을 끈 채로 접속했고(`k8sFactory.NewWithToken` → `NewInsecureWithToken`),
**그 연결로 사용자 id_token 이 그대로 나갔다.** 등록은 201 로 성공했으므로 응답만 봐서는 알 수 없었다.

로컬 kind 처럼 CA 를 넣을 수 없는 환경만 백엔드에 `KBP_DEV_ALLOW_INSECURE_CLUSTERS=true` 를 준다.
**운영에서는 켜지 않는다** — 이 값이 켜져 있으면 위 검증과 접속 시점 검증이 둘 다 비활성이다.
아래 A 경로(DB 직접 insert)는 API 를 거치지 않으므로 검증도 거치지 않는다. 직접 넣을 때는 본인이 확인해야 한다.

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

`name` 과 `ca_bundle` 둘 다 **필수**다(후자는 위 검증 때문에). 필드 표 전체는 `openapi.yaml` 의
`CreateClusterRequest` 참조.

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

**에러는 전부 한 가지 형태다.** `Problem{type,title,status,detail,request_id}`. 분기는 `title` 로 한다 —
값의 닫힌 목록은 `openapi.yaml` 의 `ErrorKind` enum 에 있고, 새 kind 가 몰래 생기면
`backend/internal/api/error_shape_test.go` 와 `openapi_spec_test.go` 가 빌드를 깬다. `detail` 은 사람이
읽는 문장이라 바뀔 수 있다.

**409 는 `title` 로 셋이 갈린다.** `conflict` 는 같은 이름의 릴리스가 이미 있다는 뜻이라 다른 이름으로
풀린다. 같은 `conflict` 라도 `detail: version not published` 는 이름으로 안 풀린다. `resource-conflict` 는
**템플릿이 만드는 오브젝트를 같은 네임스페이스의 다른 릴리스가 이미 쥐고 있다**는 뜻이라, 역시 이름을
바꿔도 안 풀린다([#161](https://github.com/shyuni4u/kubeport/issues/161)). 다른 네임스페이스에 배포하거나
그 릴리스를 먼저 지워야 한다. 이 kind 만 확장 필드 `conflicts[]`(`kind`·`name`·`namespace`·`owner`)를
달고 온다. 붙잡고 있는 릴리스 이름은 `detail` 을 파싱하지 말고 `owner` 에서 읽는다(kubeport 가 만든 게
아니면 빈 문자열). 이 응답을 받았다면 **아무것도 적용되지 않았고 릴리스도 기록되지 않았다.**

**읽기 권한이 없는 오브젝트**(쓰기 전용 Role 의 Secret 등)는 읽어서 확인할 수 없다. **생성**에서는 서버측
dry-run create 로 존재 여부만 확인해, 있으면 `owner` 없이 `owner_unknown: true` 로 충돌에 넣는다(누가 쥐었는지는
볼 수 없다 — "kubeport 밖에서 만든 것" 으로 안내하지 말 것). **업데이트**에서는 자기 오브젝트와 구별할 수 없어
검사하지 못하고 통과시키므로, 200 이 "그런 오브젝트를 빼앗지 않았다" 는 보장은 아니다.

템플릿 오브젝트가 릴리스와 다른 `metadata.namespace` 를 박고 있으면 `400 validation-error` 에 `pinned_namespace`
(`kind`·`name`·`namespace`)가 붙는다([#137](https://github.com/shyuni4u/kubeport/issues/137)). 요청이 아니라
**템플릿**을 고쳐야 하는 경우라, 이 필드가 있으면 "입력값을 확인하라" 고 안내하지 말 것.

**#161 이전에 오브젝트를 빼앗긴 릴리스**는 업데이트가 `resource-conflict`(`owner` = 빼앗은 릴리스)로 거절된다.
빼앗은 릴리스를 지우면 그 오브젝트, 즉 **피해 릴리스가 실제로 돌리던 워크로드도 함께 지워진다.** 지운 직후 피해
릴리스를 같은 값으로 한 번 업데이트하면 다시 만들어진다. `owner` 가 어느 화면에도 없는 이름이면 강제 삭제
(`?force=true`)나 로컬 `seed.sh -reset` 이 남긴 고아다 — `kubectl -n <ns> delete <kind>/<name>` 로 정리한다.

여기엔 **kubeport 의 두 진입점 어디에도 핸들러가 없는 응답까지 포함된다**
([#81](https://github.com/shyuni4u/kubeport/issues/81)):

- 라우트가 없는 경로 → `404 not-found`. 예전엔 gin 기본값인 `text/plain` `404 page not found` 였고,
  BFF 가 업스트림 content-type 을 그대로 넘기므로 클라이언트까지 그대로 갔다.
- 경로는 맞는데 메서드가 틀림 → `405 method-not-allowed`. 예전엔 이것도 404 라서 **에이전트가
  "리소스가 없다"로 결론내고 재시도를 포기**했다.
- `/api/v1` (세그먼트 0개) → `404 not-found`. Next 의 `[...path]` 가 안 잡아서 HTML 404 였다.
- 핸들러가 패닉 → `500 internal`. `gin.Recovery()` 는 본문도 content-type 도 없는 빈 500 을 냈다.
  핸들러 버그가 만드는 응답이라 에이전트가 실제로 가장 자주 만나는 5xx 인데, 그게 유일하게
  JSON 이 아니었다.

넷 다 **요청 경로를 본문에 되돌려주지 않는다.** 호출자는 자기가 뭘 보냈는지 이미 알고, 호출자가
정한 문자열을 응답에 반사하는 건 #72 가 액세스 로그에서 막은 것과 같은 종류의 실수다.

405 는 **인증 게이트보다 먼저** 나온다(라우터 전역 미들웨어라 `/v1` 그룹의 `requireAuth` 밖).
따라서 비인증 호출자도 경로 존재 여부와 `Allow` 를 알 수 있다. 감수한 트레이드오프다 — 라우트
목록은 어차피 `openapi.yaml` 로 공개돼 있고, 405 가 말하는 건 "여기 뭔가 등록돼 있다" 뿐이다.
재시도할 때는 `Allow` 헤더(예: `GET, POST`)를 보고 메서드를 고르면 된다.

**실패를 신고할 땐 `request_id` 를 같이 적는다.** 모든 응답에 `X-Request-Id` 헤더가 붙고, 에러 본문의
`request_id` 가 같은 값이다. 인바운드 `X-Request-Id` 는 `^[A-Za-z0-9._-]{1,64}$` 에 맞으면 그대로
채택되므로 **BFF 를 지나도 내 추적 id 가 살아남는다** (형식이 안 맞으면 서버가 새로 만든다. 헤더 값에는
공백과 `=` 가 허용돼서, 제한이 없으면 액세스 로그의 필드를 위조할 수 있다).

**500 은 이유를 알려주지 않는다.** `detail` 은 "어떤 작업이 실패했는지"까지다
([#49](https://github.com/shyuni4u/kubeport/issues/49)) — 예전에는 pgx 접속 문자열(`host=… user=…`)과
apiserver 주소가 그대로 나갔다. 이유는 서버 로그에 있고, `request_id` 가 그 줄을 찾는 열쇠다.
반면 **502 의 `detail` 은 apiserver 가 실제로 답한 경우에만** 원문이다(Forbidden/Invalid/NotFound/
AlreadyExists/Conflict/Unauthorized). "User x cannot create deployments" 는 배포가 거부된 이유이므로
화면에 있어야 한다. 전송 자체가 실패한 경우는 클러스터 내부 주소가 들어가므로 로그로만 간다.

단 **클러스터 openapi 읽기 두 라우트는 이 일반 규칙의 예외**다. 아래 표대로 apiserver 의 401/403
도 kubeport 자신의 문장을 단 502 로 접히고, apiserver 원문이 `detail` 에 남는 건 404 하나뿐이며
그것마저 관리자에게만 보인다.

**클러스터 openapi 읽기 두 라우트는 업스트림 상태를 그대로 흘리지 않는다**
([#83](https://github.com/shyuni4u/kubeport/issues/83)). 통과하는 건 404 뿐이고 — "이 클러스터엔
`apps/v99` 가 없다"는 내가 던진 질문에 apiserver 가 답한 것이라 — 나머지는 kubeport 자신의 502 로
접힌다.

| 업스트림 | 나오는 응답 | 재시도 |
|---|---|---|
| 401 · 403 | `502 cluster-auth-denied` | ✗ 그 클러스터에 대한 내 권한이 바뀌어야 한다 |
| 404 | `404 k8s-error` (`detail` 원문은 관리자만, 그 외엔 고정 문장) | ✗ 없는 group/version |
| 그 외 4xx (429 포함) | `502 k8s-error` | 상황에 따라 |
| 5xx | `502 k8s-error` | ○ 대개 일시적 |

401 을 접는 게 핵심이다. 그대로 흘리면 "**kubeport** 세션이 잘못됐다"로 읽혀서 클라이언트가 재로그인
→ 똑같이 거부되는 토큰 획득 → 무한 반복이 된다. `cluster-auth-denied` 는 "kubeport 은 나를 알지만
**클러스터가** 나를 거부했다"는 뜻이고, 재로그인으로는 절대 풀리지 않는다. 업스트림 429 를 접는
이유도 같다 — kubeport 자신의 429 는 `Retry-After` 를 달고 오는데, 업스트림 429 엔 그게 없다.

**SSE 로그 스트림의 에러도 같은 `Problem` 이다**([#82](https://github.com/shyuni4u/kubeport/issues/82)).
예전엔 스트림 시작 전은 `Problem`, 시작 후는 `{"error": "..."}` 라 파서를 두 벌 들고 있어야 했다.

```
event:error
data:{"type":"...","title":"k8s-error","status":502,"detail":"...","request_id":"..."}
```

`detail` 은 **일부러 두루뭉술하다** — client-go 원문에 apiserver 주소·네임스페이스·파드 이름이 들어
있고 이 프레임은 로그 창에 그대로 렌더된다([#108](https://github.com/shyuni4u/kubeport/issues/108)).
진짜 이유는 서버 로그에 있고 `request_id` 로 찾는다. 대신 **분기는 `title` 로 한다**:

| `title` | 상태 | 뜻 | 재시도 |
|---|---|---|---|
| `rbac-denied` | 403 | 릴리스는 볼 수 있지만 그 파드의 로그 권한이 없다 | ✗ 클러스터 RBAC 이 바뀌어야 한다 |
| `cluster-auth-denied` | 502 | 클러스터가 전달된 토큰을 거부 | ✗ 재로그인으로 안 풀린다 |
| `k8s-error` | 502 | 전송 실패 등 그 외 | ○ |

`error` 프레임이 왔다고 스트림이 끝난 건 아니다 — `instance=all` 이면 핸들러는 나머지 정상 파드를
계속 따라간다. **끝은 `end` 프레임이 알린다**([#162](https://github.com/shyuni4u/kubeport/issues/162)):

```
event:end
data:{"reason":"all pods stopped emitting"}
```

`end` 가 마지막 프레임이고 서버는 곧바로 연결을 닫는다. **`end` 를 받으면 클라이언트가 직접
`close()` 한다.** 표준 `EventSource` 는 닫히면 3초 뒤 자동 재연결하므로, 로그가 다 나온 파드 —
끝난 Job 이 그렇다 — 를 열어 두면 그 재연결이 영원히 반복된다.

`end` 없이 닫힌 것은 정말로 끊긴 것이라 재연결이 맞다. 위 표에서 재시도 ✗ 인 kind 를 받았다면
`end` 를 기다리지 않고 바로 닫아도 된다.

### 재연결은 재개다 — 처음부터 다시가 아니다

**`?instance=<파드>` 로 연 스트림**의 `log` 프레임에는 SSE `id:` 가 붙는다(kubelet 스탬프가 없는 줄
제외). 값은 그 줄이 쓰인 시각이다:

```
id:2026-09-09T07:36:36.123456789Z
event:log
data:{"time":1788939396123,"pod":"web-...","text":"..."}
```

**`id` 형식은 고정이다 — 항상 UTC, 소수 정확히 9자리.** 그래서 문자열 순서와 시간 순서가 같다.
받은 값 중 가장 큰 것을 커서로 골라도 안전하고, 직접 만들 때도 같은 형식을 쓴다(`?since=` 는 자릿수·
오프셋이 달라도 받아 준다).

**`time` 은 그 줄을 컨테이너가 쓴 시각(unix ms)이고 `id` 를 밀리초로 자른 값이다.** #131 이전에는
서버가 **전달한** 시각이었다 — 의미가 바뀌었다. 과거 로그를 재생하면 과거 시각이 오고,
`instance=all` 에서는 파드들이 섞여 **프레임 순서와 `time` 순서가 다를 수 있다.** 예전 값은 단조
증가했으므로 `time` 을 진행 표시나 정렬 키로 쓰던 클라이언트는 조용히 틀린다. 재개 커서는 `time` 이
아니라 `id` 다.

표준 `EventSource` 는 마지막으로 본 `id` 를 기억했다가 자동 재연결 시 `Last-Event-ID` 헤더로
돌려보낸다 — **클라이언트 코드가 필요 없다**([#107](https://github.com/shyuni4u/kubeport/issues/107)).
`EventSource` 를 안 쓰는 호출자는 같은 값을 `?since=<RFC3339>` 로 넘긴다. 둘 다 있으면 `?since=` 가
이긴다.

**단, `?instance=` 로 파드를 지정했을 때만이다.** `instance=all`(기본값) 은 `id` 를 안 붙인다 —
예전처럼 처음부터 다시 받는다. **지금 파드가 하나뿐이어도 마찬가지다.** 이때 `?since=` 를 주면
**`400 validation-error`** 다 — 조용히 무시하고 200 으로 전체 로그를 주면 재개가 되는 것처럼 보이면서
재연결마다 중복된다. (`Last-Event-ID` 헤더는 거절하지 않고 무시한다. 브라우저가 인스턴스를 바꿔도
같은 `EventSource` 에 남겨 두는 값이라서다.)

이유가 둘이다. 시각 하나는 파드 여러 개의 진행을 대표할 수 없다 — 파드들은 동시에 따라가며 순서
없이 합쳐지므로 가장 최근 `id` 는 **마지막으로 쓴 파드의 것**이고, 그걸로 전 파드를 재개하면 느린
파드가 아직 못 흘린 구간이 **조용히, 영구히** 건너뛰어진다. 그리고 `all` 이 가리키는 집합은
고정이 아니다 — 레플리카 1개짜리가 롤아웃되면 재연결 시에도 파드는 여전히 하나인데, **떠난 파드의
커서가 그 자리를 대신한 파드에 적용된다.**

줄을 다시 보내는 쪽이 싸다. 파드별 커서는 [#172](https://github.com/shyuni4u/kubeport/issues/172) 로
따로 본다.

**이름을 지정하면 재개된다.** 이름은 요청에 들어 있으므로 재연결해도 같은 파드를 가리키고, 그
파드가 사라졌다면 다른 파드가 그 위치를 물려받는 대신 `404 no-pods` 가 온다.

kubelet 스탬프가 없는 줄도 `id` 를 안 받는다. 그 줄의 `time` 은 화면에 찍을 값이 필요해서 서버
시계로 채운 것이라, 커서에 넣으면 "지금까지 읽었다" 고 주장하는 셈이 된다.

**중복 제거는 서버가 한다.** 클러스터의 필터가 초 단위라 요청한 그 초의 줄이 전부 돌아오는데,
서버가 정확한 시각과 각 줄의 나노초를 비교해 이미 보낸 몫을 잘라낸다. kubelet 스탬프가 없는
줄은 비교할 수 없으므로 **항상 보낸다** — 중복 가능성이 줄이 조용히 사라지는 것보다 낫다.

재개 지점을 안 주면 컨테이너 로그를 처음부터 받는다. 첫 연결이 원하는 동작이고, 웹 UI 의
`다시 연결` 버튼도 그렇게 한다 — 그 버튼은 패널을 함께 비우기 때문이다.

**파싱할 수 없는 값의 처리는 출처에 따라 다르다.**

- `?since=` 가 깨졌으면 `400 validation-error` 다. 호출자가 쓴 값이고, 전체 로그로 답하면 무시당한
  줄 모르고 계속 보내게 된다.
- `Last-Event-ID` 가 깨졌으면 **에러가 아니라 처음부터 보낸다.** 그 값은 아무도 타이핑하지 않았다 —
  브라우저가 자동 재연결마다 스스로 다시 붙이고 페이지에서는 지울 방법이 없다. 거절하면 탭이 열려
  있는 동안 매 재연결이 실패하고, 비-2xx 에 `EventSource` 가 포기하므로 새로고침 전까지 로그 창이
  죽는다. 재생은 비싸지만 잠김은 창을 잃는다.

입력만 보고 판단할 수 있는 검사(`?since=` 형식, 인스턴스 이름 길이)는 **클러스터에 묻기 전에**
끝난다. 잘못된 요청이 apiserver 파드 LIST 를 한 번씩 쓰고 나서 거절되지 않는다.

`reason` 은 **분기 키가 아니다** — 닫힌 어휘도 빌드 가드도 없는 사람용 문장이고, 지금은 항상
`all pods stopped emitting` 하나다. 실패로 끝난 이유를 알아야 하면 직전 `error` 프레임의 `title`
을 본다.

**`end` 는 순증이라 기존 클라이언트를 깨뜨리지 않는다.** 이름 붙은 이벤트는 리스너를 등록하지
않은 `EventSource` 에 전달되지 않는다(`onmessage` 는 이름 없는 이벤트만 받는다). 다만 `data:` 줄을
전부 로그 본문으로 찍는 소박한 파서는 이 페이로드를 한 줄로 출력한다 — **페이로드가 아니라 이벤트
이름으로 분기하라.**

**429 를 만나면 `Retry-After` 를 지킨다.** `POST /v1/selfsubjectaccessreview`, 클러스터 openapi 읽기,
로그 스트림 열기가 호출자(OIDC subject)별 토큰버킷 하나를 공유한다 — 분당 60회, 버스트 동일
([#73](https://github.com/shyuni4u/kubeport/issues/73)). 429 응답에 `Retry-After`(초)와 `X-RateLimit-Limit`·
`X-RateLimit-Remaining` 이 붙는다. 즉시 재시도하면 제한만 다시 맞는다. 데모의 Dex 계정 2개는 정적이라
동시 접속자들이 **한 버킷을 공유**한다는 점도 감안할 것.
`GET /v1/releases/{id}` 도 요청마다 클러스터에 파드 목록을 묻지만 **별도 버킷**(분당 240회)을 쓴다
([#212](https://github.com/shyuni4u/kubeport/issues/212)) — 화면이 목록의 행마다, 자리 잡는 중인 상세를 주기적으로
읽는 경로라 위 버킷과 합치면 SSAR·로그 열기가 굶는다. 상태를 폴링하는 클라이언트는 호출자당 분당 240회 안에서
돈다 — 성공 응답에는 남은 양 헤더가 붙지 않으니 스스로 간격을 둔다. 버킷은 헤더가 아니라 **호출한 라우트**가
정한다(분당 60회인 버킷이 둘이라 `X-RateLimit-Limit` 값으로는 구분되지 않는다). 데모 계정은 이 240회도 방문자 전원이
나눠 쓴다. 릴리스 생성·수정·삭제(`POST /v1/releases`, `PUT`·`DELETE /v1/releases/{id}`)는 요청 하나가 객체마다
dry-run·apply 나 종류마다 DeleteCollection 을 부르는 가장 비싼 경로라, 셋이 **분당 30회 버킷 하나**를 함께 쓴다
([#232](https://github.com/shyuni4u/kubeport/issues/232)) — 동사를 바꿔도 새 버킷이 생기지 않는다. 사람이 배포 폼을 내거나
삭제를 누르는 속도에는 걸리지 않으니, 이걸 넘는 자동화는 쓰기 사이에 2초 이상 간격을 둔다. 토큰은 **클러스터를
부르기 직전에** 쓰인다 — 그 전에 거절되는 쓰기(본문 오류 400, 남의 릴리스 403, 없는 템플릿·릴리스 404, 발행되지
않은 버전 409 등)는 예산을 쓰지 않는다. 같은 이름의 릴리스가 이미 있는 409 는 클러스터 API 를 부르지 않지만 DB 삽입 시점에 판정되므로 토큰을 쓴다 — 데모
공유 계정에서 의도적으로 예산을 비우는 경우는 [#200](https://github.com/shyuni4u/kubeport/issues/200) 의 범위다. 데모 계정이 공유 신원이라 거절될 요청만으로 방문자 전원의 쓰기를 막지 못하게 하려는 것이다.

**로그 스트림은 동시에 열어 둘 수 있는 개수에도 상한이 있다**([#169](https://github.com/shyuni4u/kubeport/issues/169)).
위 버킷은 스트림을 **여는** 횟수만 센다 — 한 번 열린 스트림은 몇 시간을 붙들고 있어도 토큰을 더 쓰지
않는다. 그런데 열린 스트림 하나가 파드마다 goroutine 하나와 apiserver 연결 하나를 계속 잡고 있어서,
여는 속도만 제한해서는 붙들고 있는 개수가 무한히 늘 수 있다. 그래서 같은 호출자가 동시에 열어 둔
스트림이 상한에 닿으면 새 스트림은 **`429 too-many-streams`** 다 (기본 16개. 자가호스팅 설치는 Helm 값 `backend.logStreamsPerCaller` —
환경변수 `KBP_LOG_STREAMS_PER_CALLER` — 로 바꾼다).

- **`rate-limited` 와 `title` 로 구분한다.** 둘 다 429 지만 풀리는 방식이 다르다. `rate-limited` 는
  시간이 지나면 풀리고, `too-many-streams` 는 그 호출자의 스트림 하나가 **닫혀야** 풀린다. 기다리기만
  하는 재시도 정책으로는 자기 스트림을 닫아야 한다는 걸 알 수 없다.
- 이때도 `Retry-After` 는 붙지만 **예측이 아니라 백오프 힌트**다. 자리가 언제 날지는 서버도 모른다.
- `X-RateLimit-Limit`·`X-RateLimit-Remaining` 은 **붙지 않는다.** 그 둘은 분당 요청 수를 뜻하는데, 이
  거절은 열린 스트림 **개수** 때문이라 그 값을 넣으면 틀린 숫자가 된다.
- 필요 없어진 스트림은 닫는다. 상한은 호출자별이라 **데모의 공유 계정은 이 상한도 공유**한다.

**로그 스트림은 수명도 있다 — 기본 1시간**(자가호스팅 설치는 Helm 값 `backend.logStreamMaxLifetime` —
환경변수 `KBP_LOG_STREAM_MAX_LIFETIME`, Go duration 예 `30m` — 로 바꾼다). 시간이 되면 서버가 스트림을
끊고, 이때 **`end` 프레임은 오지 않는다.** 끝난 게 아니라 교체이기 때문이다. 그러니 평범한 끊김처럼
**재연결**하면 된다 — `EventSource` 는 알아서 한다. 이름 지정 인스턴스는 커서에서 재개되고, `instance=all`
은 처음부터 다시 받는다.

이게 필요한 이유: 브라우저와 백엔드 사이의 어떤 것도 열린 스트림을 닫지 않는다(프록시 Traefik 의
`writeTimeout` 은 0 이고, `idleTimeout` 은 15초 ping 때문에 발동하지 않는다). 그리고 스트림은 핸드셰이크
이후 호출자를 **다시 확인하지 않는다.** 그래서 권한이 회수되거나 세션이 만료돼도 탭이 열려 있는 동안은
로그가 계속 흘렀다. 재연결은 새로 갱신된 토큰으로 인가를 다시 거친다.

**요청 바디는 4 MiB 까지다.** 넘으면 **`413 payload-too-large`** 다([#128](https://github.com/shyuni4u/kubeport/issues/128)).
예전에는 읽다가 끊긴 오류가 `400 validation-error` 로 접혀, `detail` 의 Go 영어 문장(`http: request body too large`)으로만
구분됐다.

- **`validation-error` 와 처방이 반대다.** 그쪽은 본문을 고쳐 다시 보내면 풀리지만, 이쪽은 **같은 요청을 그대로 재시도하면
  영원히 거절된다.** 크기를 줄여야 한다 — 템플릿이면 리소스를 덜어내거나 여러 템플릿으로 나눈다.
- `Content-Length` 가 한도를 넘으면 **라우팅·인증보다 먼저** 413 이다. 메서드를 가리지 않고(바디를 읽지 않는 `GET` 이라도
  그 길이를 선언했으면), 세션 없는 호출도 401 이 아니라 413 을 받는다. 길이를 미리 알 수 없는 chunked 바디는 핸들러가
  읽다가 한도에서 끊고 같은 413 을 준다.
- 서버는 넘친 바디를 끝까지 받지 않고 응답 뒤 연결을 닫는다. 전송이 끝나기 전에 연결이 끊겨 응답 본문을 못 읽는
  클라이언트도 있으니, **보내기 전에 크기를 재는 쪽**이 확실하다.
- BFF(`/api/v1/*`)로 붙어도 같은 Problem 이 그대로 전달된다 — BFF 에는 따로 바디 한도가 없다.

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

SSAR 은 **물어볼 수 있는 질문이 정해져 있다**(#73). `verb` 는 kubeport 가 실제로 수행하는 것만 —
`create` `update` `patch` `delete` `deletecollection` `get` `list` `watch`. `deletecollection` 이 있는
이유는 릴리스 삭제가 `DeleteCollection` 을 쓰고 k8s 가 이를 `delete` 가 아닌 자기 verb 로 인가하기
때문이다. `(group, resource)` 는 MVP 리소스 10종만 — `configmaps` `persistentvolumeclaims` `secrets`
`services` `apps/daemonsets` `apps/deployments` `apps/statefulsets` `batch/cronjobs` `batch/jobs`
`networking.k8s.io/ingresses`. 벗어나면 400 이고, **`detail` 이 허용 집합을 그대로 나열**하므로 목록을
외울 필요는 없다.

응답의 `reason` 은 **관리자에게만** 채워진다([#102](https://github.com/shyuni4u/kubeport/issues/102)).
k8s authorizer 는 `RBAC: allowed by ClusterRoleBinding "..." of ClusterRole "..." to User "..."` 처럼
**클러스터의 RBAC 오브젝트 이름을 그대로** 답하는데, SSAR 은 인증만 되면 누구나 호출할 수 있어서
네임스페이스를 바꿔가며 물으면 바인딩 구조가 윤곽을 드러냈다. 권한 상승은 아니고 정보 노출이다.
데모 계정은 `kubeport-admin` 을 갖고 있어도 빈 문자열을 받는다 — 그 그룹은 관리자 UX 를 보여주려고
있는 것이지 호스트 클러스터 구성을 공개하려고 있는 게 아니다. `allowed`·`denied` 는 그대로다.

**201 은 "적용을 접수했다"는 뜻이지 "떴다"가 아니다.** 상태는 `GET /v1/releases/{id}` 의 `status` 로
확인한다. 그 값은 요청 시점에 클러스터를 조회해 만드는 파생값이라 저장돼 있지 않고, 따라서 "여기서 끝"
이라고 볼 종료 상태가 없다. 목록(`GET /v1/releases`)에는 status 가 아예 없어서 N개 릴리스를 폴링하면
클러스터 왕복도 N번이다 ([#57](https://github.com/shyuni4u/kubeport/issues/57),
[#58](https://github.com/shyuni4u/kubeport/issues/58)).

**웹 UI 도 같은 방식으로 폴링한다**([#183](https://github.com/shyuni4u/kubeport/issues/183)). 릴리스 상세
화면은 `status` 가 `unknown`·`warning` 인 동안 `GET /v1/releases/{id}` 를 3·5·8·13초 뒤, 이후 15초 간격으로
다시 부르고 5분이 지나면 멈춘다(탭이 숨겨져 있으면 그 회차를 건너뛴다). 한 번 다시 읽을 때마다 백엔드가
해당 네임스페이스의 파드를 조회하므로, 열린 탭 하나가 5분 동안 apiserver 에 수십 번의 LIST 를 보낸다.
파드가 0개인 릴리스는 여기에 더해 렌더된 오브젝트마다 GET 을 한 번씩 보낸다 — 오브젝트가 남아 있는지
(`unknown`) 사라졌는지(`resources-missing`) 가르기 위해서다([#33](https://github.com/shyuni4u/kubeport/issues/33)).
호출자가 그 kind 들을 하나도 `get` 할 수 없으면 `resources-missing` 에 도달하지 못하고 `unknown` 에 머문다. 이
경로는 위 토큰버킷 대상이 아니다. 파드가 없는 동안 `unknown` 에 머무는 CronJob 릴리스는 상세를 열 때마다
5분 전체를 소비한다.

**목록은 페이지네이션 메타가 없다.** `total` 도 `next` 도 없어서 "다음 페이지가 있나"는 한 페이지가 꽉
찼는지로 추측해야 한다. 템플릿 목록은 아예 페이지네이션이 없다(#58).

**BFF 가 직접 답하는 응답 6가지.** `/api/v1/*` 로 붙는 경우(§1 의 B 경로), 아래는 Go API 까지 가지 않고
Next.js Route Handler 가 만든다. 499 를 뺀 다섯은 같은 `Problem` 스키마다.

| 상태 | `title` | 언제 |
|---|---|---|
| 401 | `unauthenticated` | 세션 쿠키가 없거나 만료 — 토큰 갱신도 실패 |
| 500 | `internal` | 세션 테이블(Postgres)을 못 읽음 |
| 502 | `internal` | Go API 가 안 뜸 — 연결 거부·DNS·타임아웃. 예전엔 Next 기본 500(HTML, `X-Request-Id` 없음)이었다 |
| 400 | `validation-error` | 경로가 이상함(`detail: malformed request path`). 세그먼트에 `/`·`..`·제어문자가 있거나, 조립된 URL 이 `/<base>/v1/` 밖으로 나가면 업스트림에 보내지 않는다 ([#51](https://github.com/shyuni4u/kubeport/issues/51)) |
| 404 | `not-found` | `/api/v1` 자체를 찌른 경우. 세션 검사도 안 한다 — 누가 묻든 여긴 아무 데도 안 이어지고, 401 을 먼저 주면 "뭔가 있긴 하다"는 뜻이 된다 (#81) |
| 499 | — | 클라이언트가 먼저 끊음(nginx 관례). **본문이 없으므로** id 는 `X-Request-Id` 헤더로만 온다 |

---

## 관련

- [`backend/api/openapi.yaml`](../backend/api/openapi.yaml) — API 계약
- [docs/local-e2e.md](local-e2e.md) — 로컬 스택 전체 세우기
- [deploy/helm/kubeport/README.md](../deploy/helm/kubeport/README.md) — 설치와 설치 후 필수 단계
- [#34](https://github.com/shyuni4u/kubeport/issues/34) 비대화형 토큰 ·
  [#25](https://github.com/shyuni4u/kubeport/issues/25) MCP 서버
