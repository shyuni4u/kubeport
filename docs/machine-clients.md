# 스크립트·에이전트에서 kubeport API 호출하기

사람이 브라우저로 쓰는 것 말고, **스크립트나 AI 에이전트가** kubeport 를 조작하려 할 때 필요한 것들.
API 계약 자체는 [`backend/api/openapi.yaml`](../backend/api/openapi.yaml) 에 있고, 이 문서는 **어디로
어떻게 붙느냐**만 다룬다.

> **요약을 먼저:** 로컬 개발 환경에서는 dex 의 password grant 로 토큰을 얻어 바로 호출할 수 있다(§2, 검증됨).
> **운영 환경(Google IdP)에는 비대화형 토큰 획득 경로가 아직 없다**(§3). 클러스터 등록 같은 운영자 1회성
> 작업은 §4 의 우회 경로를 쓴다. 장기 해법은 [issue #34](https://github.com/shyuni4u/kubeport/issues/34).

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
kubectl -n kubeport port-forward svc/<release>-backend 8080:8080 &
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/me
```

`GET /v1/me` 는 토큰이 살아 있는지, 그리고 내가 관리자인지(`groups` 에 `kubeport-admin`) 확인하는
가장 싼 방법이다.

---

## 2. 로컬 개발 — dex password grant (검증됨)

`deploy/docker/docker-compose.yml` 의 dex 는 password grant 를 허용하므로 브라우저 없이 토큰이 나온다.

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

**2026-09-09 확인 결과** — 위 요청이 돌려주는 id_token 의 클레임:

```json
{
  "iss": "https://localhost:15556",
  "aud": "kubeport",
  "email": "admin@example.com",
  "email_verified": true,
  "name": "admin"
}
```

여기서 두 가지가 중요하다.

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

## 3. 운영 환경 — 아직 지원되는 경로가 없다

운영은 Google 을 IdP 로 쓴다(`deploy/helm/kubeport/values.yaml` 의 `oidc.issuer`). 문제는:

- **Google 은 password grant 를 지원하지 않는다.** §2 방식이 그대로는 안 통한다.
- **`client_credentials` 는 이 리포 어디에도 구현돼 있지 않다.** 백엔드는 `requireAuth` 에서 오직
  id_token 만 검증한다(`backend/internal/api/middleware.go`).
- **브라우저 세션에서 토큰을 꺼낼 수 없다.** 세션 쿠키는 httpOnly 라 JS 로 못 읽고, 애초에 쿠키 안에
  토큰이 없다 — 서버 측 DB 에 암호화되어 저장된다(`sessions` 테이블).

즉 **라이브 kubeport 에 대해 사람 없이 토큰을 얻는 문서화된 방법이 0개**다. 이게
[issue #34](https://github.com/shyuni4u/kubeport/issues/34) 의 내용이고, 후보 해법 두 가지는:

1. **서비스 계정 토큰(장수명 API key)을 `/v1` 에 도입** — `Authorization: Bearer kbp_...` 를
   `requireAuth` 가 함께 받도록. 다만 kubeport 의 보안 모델은 "사용자 토큰을 k8s 로 그대로 포워딩"
   이라, 서비스 계정은 **k8s 쪽 신원도 함께 정해야** 한다. 단순한 추가가 아니다.
2. **IdP 쪽에서 서비스 계정 발급** — Google 서비스 계정으로 대상 audience 의 id_token 을 받는 방식.
   이 경우 그 서비스 계정 이메일에 대해 k8s RBAC 바인딩도 별도로 걸어야 한다.

둘 다 설계 결정이 필요하므로 여기서 임의로 안내하지 않는다. **현재로서는 운영 환경의 자동화가
불가능하다는 것이 정확한 답이다.**

---

## 4. 운영자 1회성 작업 — 클러스터 등록

설치 직후 대상 클러스터를 등록하는 건 §3 의 공백에도 불구하고 지금 해야 하는 일이다. 두 가지 경로가 있다.

**A. DB 에 직접 insert.** `deploy/oci/README.md` §7.4 가 허용하는 방식이다. 클러스터 접속 정보는
인프라 설정이지 PII 가 아니므로 이 경로가 정당하다. 토큰이 아예 필요 없어서 가장 확실하다.

**B. port-forward + 토큰.** 토큰을 어떻게든 손에 넣었다면:

```bash
kubectl -n kubeport port-forward svc/<release>-backend 8080:8080 &

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

`name` 은 **필수**이고, `ca_bundle` 은 필수가 아니지만 **비우면 백엔드가 TLS 검증을 끈 채로 접속하면서도
201 을 돌려준다** — 응답만 봐서는 알 수 없다. 운영 클러스터에서는 반드시 넣는다. 필드 표 전체는
`openapi.yaml` 의 `CreateClusterRequest` 참조.

관리자 판정은 `KBP_DEV_ADMIN_EMAILS`(차트의 `auth.devAdminEmails`)에 이메일이 있어야 선다 — Google 은
`groups` 를 발급하지 않기 때문이다. 이걸 안 하면 위 호출이 `403 admin group required` 로 막힌다.
자세한 건 `deploy/helm/kubeport/README.md` 의 "After install" 0단계.

---

## 5. 호출할 때 알아두면 좋은 것

**에러는 전부 한 가지 형태다.** `Problem{type,title,status,detail}`. 분기는 `title` 로 한다 —
값의 닫힌 목록은 `openapi.yaml` 의 `ErrorKind` enum 에 있고, 새 kind 가 몰래 생기면
`backend/internal/api/error_shape_test.go` 가 빌드를 깬다. `detail` 은 사람이 읽는 문장이라 바뀔 수 있다.

**비인증 호출은 JSON 401 이다.** BFF 든 Go API 든:

```json
{"type":"https://kubeport.io/errors/unauthenticated","title":"unauthenticated","status":401,"detail":"..."}
```

(예전에는 BFF 가 로그인 화면으로 307 리다이렉트를 보냈고, 따라가면 Google 동의 화면이 200 으로 떨어져
성공으로 오인되기 쉬웠다. [#24](https://github.com/shyuni4u/kubeport/issues/24) 에서 고쳤다.)

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
