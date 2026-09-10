# kubeport — 초기 디자인 스펙

| | |
|---|---|
| 버전 | 0.2 (draft) |
| 날짜 | 2026-04-16 |
| 상태 | **사용자 리뷰 대기** |
| 범위 | MVP + v1.1 큰 틀. v2+는 언급만 |
| 이전 문서 | [CLAUDE.md](../../../CLAUDE.md), [docs/brainstorming-summary.md](../../brainstorming-summary.md) |
| 변경 이력 | v0.2 (2026-04-16) — Frontend 배포를 Vercel → k8s Pod (Helm chart 통합) 로 변경. 상세: [ADR 0001](../../decisions/0001-frontend-deployment-helm-over-vercel.md). · v0.1 (2026-04-16) — 초안. |

이 문서는 브레인스토밍 결과를 통합한 **구현 전 최종 스펙**이다. 승인 후 이 문서를 바탕으로 implementation plan(`writing-plans` 스킬)을 작성한다.

---

## 1. 문제 정의와 목표

### 1.1 문제

Kubernetes 리소스(YAML)의 일상적 CRUD는 비전문 사용자에게 진입 장벽이 크다. 기존 도구는 다음 세 가지 중 일부만 해결한다:

| 도구 | 관리자 추상화 | 사용자 셀프서비스 | 배포 후 운영 |
|------|---------------|-------------------|--------------|
| k9s / Lens / Headlamp | ✗ | ✗ (전문가 전용) | ✓ |
| Rancher / OpenShift | △ (Helm 전제) | △ | △ |
| Backstage Software Templates | ✓ | ✓ | ✗ (스캐폴딩 중심) |
| Octopod | △ (Helm 전제) | ✓ | △ |
| Crossplane Composition | ✓ (선언형) | — | ✗ |

셋 모두를 만족하는 제품이 없음.

### 1.2 목표

"**k8s 관리자가 템플릿을 한 번 만들면, 일반 사용자는 k8s를 몰라도 그 템플릿으로 배포·일상 운영·관찰까지 가능**."

### 1.3 비유

Swagger가 OpenAPI spec을 인터랙티브 웹 UI로 변환하듯, **k8s 리소스를 추상화된 셀프서비스 포털로 변환**한다.

---

## 2. 사용자 역할

| 역할 | k8s 지식 | 주 작업 | 주 도구 |
|------|---------|---------|---------|
| **관리자 (Admin)** | 숙련 | 템플릿 작성/버전관리, 클러스터 등록 | YAML 에디터 + UI 에디터 (상호 변환) |
| **일반 사용자 (User)** | 없어도 됨 | 카탈로그에서 고르기, 폼 채우고 배포, 상태/로그 조회 | 추상화된 UI 폼과 뷰 |

"숙련도는 스펙트럼이지 이분법이 아니다." 같은 사용자가 상황에 따라 YAML/UI를 선택할 수 있다. 역할은 OIDC 그룹 클레임으로 구분한다(`groups` 에 `kubeport-admin` 포함 여부).

---

## 3. 핵심 개념: 템플릿

### 3.1 템플릿 = 세 파일 묶음

```
web-service/
├── resources.yaml    (필수) — 순수 k8s 매니페스트, placeholder 없음
├── ui-spec.yaml      (필수) — 어떤 경로를 어떤 이름으로 노출할지
└── metadata.yaml     (선택) — 설명, 태그, 아이콘 등
```

세 파일이 한 **템플릿 버전**을 이룬다. 파일 자체는 DB의 `template_versions` 테이블의 `resources_yaml` / `ui_spec_yaml` / `metadata_yaml` 컬럼에 저장된다 (파일시스템 아님).

### 3.2 예시: `web-service` v2

**resources.yaml**
```yaml
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
          resources:
            requests:
              memory: 256Mi
---
apiVersion: v1
kind: Service
metadata: { name: web }
spec:
  ports: [{ port: 80 }]
```

**ui-spec.yaml**
```yaml
fields:
  - path: Deployment.spec.replicas
    label: "인스턴스 개수"
    help: "같은 앱이 몇 개 떠 있을지"
    type: integer
    min: 1
    max: 20
    default: 3

  - path: Deployment.spec.template.spec.containers[0].image
    label: "컨테이너 이미지"
    type: string

  - path: Deployment.spec.template.spec.containers[0].resources.requests.memory
    label: "메모리 요청량"
    type: enum
    values: [128Mi, 256Mi, 512Mi, 1Gi]
    default: 256Mi
```

노출되지 않은 경로(`Service.spec.ports[0].port` = 80)는 **고정**된다.

### 3.3 ui-spec 필드 타입 (MVP)

| type | 입력 컴포넌트 | 검증 속성 |
|------|---------------|-----------|
| `string` | text input | `pattern`, `minLength`, `maxLength` |
| `integer` | number input | `min`, `max` |
| `boolean` | checkbox/toggle | — |
| `enum` | select dropdown | `values` 리스트 |

MVP 이후 추가 예정: `secret`(비밀값), `object`(중첩), `array`(동적 항목), `conditional`(다른 필드에 의존).

### 3.4 JSONPath와 멀티 리소스 식별

`path`는 `Kind.jsonpath` 형태. 같은 Kind가 여러 개면 `Kind[web]`(metadata.name) 또는
`Kind[0]`(같은 Kind 문서 중 0-based 인덱스)로 식별한다. 단일이면 생략 가능:
```yaml
- path: "Deployment[web].spec.replicas"           # name으로 식별
- path: "Deployment[0].spec.replicas"             # 인덱스로 식별 (단일이면 생략 가능)
```

`Kind[metadata.name=web]` 같은 표현식 셀렉터는 **지원하지 않는다.** `findDoc` 은 셀렉터를
인덱스 또는 `metadata.name` 과의 완전 일치로만 푼다 — 이 스펙에 예시로 남아 있었지만
구현된 적이 없고, `ValidateSpec` 은 문서를 해석하지 않으므로 저장은 통과하고
사용자가 배포하는 순간 `no Deployment matching "metadata.name=web"` 로 실패한다.

**세그먼트에 `.` · `-` · `/` 가 들어가면 인용한다.** 기본 세그먼트는 `[A-Za-z_][A-Za-z0-9_]*`
뿐이다 — k8s 라벨·애노테이션 키와 ConfigMap 데이터 키는 이 형태가 아니다:

```yaml
- path: 'Deployment[web].metadata.labels["app.kubernetes.io/name"]'
- path: "ConfigMap[conf].data['nginx.conf']"
```

인용이 **필요한** 이유는 문자 집합이 좁아서가 아니라 `.` 이 이 문법의 구분자이기 때문이다.
`metadata.labels.app.kubernetes.io/name` 은 키 하나인지 네 개인지 구분할 방법이 없다.
`/` 만 허용하면 파서는 조용히 통과하면서 `app` → `kubernetes` → `io/name` 3단 중첩을 만든다.
따옴표는 두 종류를 모두 받고 이스케이프는 없다 — 한쪽 따옴표가 든 키는 다른 쪽으로 감싼다.

UI 모드 에디터는 이 인용을 자동으로 붙인다. 손으로 ui-spec 을 쓸 때만 신경 쓰면 된다.
(근거: [issue #129](https://github.com/shyuni4u/kubeport/issues/129))

### 3.5 버저닝

- **status**: `draft` → `published` → `deprecated`
- `draft` 는 수정 가능. `published`는 **불변**. 변경하려면 새 버전을 draft로 생성 후 publish.
- 템플릿당 `draft` 최대 1개 (partial unique index).
- 릴리스는 항상 **published 버전에 pin**. 업데이트는 사용자가 수동 트리거.

---

## 4. 시스템 아키텍처

### 4.1 컴포넌트 5개

```
┌─ Browser ─┐     ┌─ Next.js (k8s Pod) ─┐    ┌─ Go API (k8s Pod) ─┐     ┌─ Target k8s ─┐
│ Next.js  │◀───▶│ Route Handler (BFF) │◀──▶│ Gin + client-go     │◀──▶│ dev/stg/prod │
│ SPA      │     │ httpOnly cookie    │     │ template render     │    └──────────────┘
│ (Monaco) │     │ OIDC callback      │     │ token forwarding    │
└──────────┘     └────────────────────┘     └──────────┬──────────┘
     │                   │                              │
     │   OIDC redirect   │                              │
     └──▶ OIDC Provider ─┘                              ▼
                                                  ┌─ App DB ─┐
                                                  │ Postgres │
                                                  └──────────┘
```

| 컴포넌트 | 역할 | 배포 위치 |
|----------|------|-----------|
| Browser (Next.js SPA) | 모든 UI 렌더링 | 사용자 브라우저 |
| Next.js Route Handler | OIDC 콜백, 서버 세션, Go API 프록시 (BFF) | k8s control 클러스터 Pod (backend와 동일 Helm chart) |
| Go API Server | 비즈니스 로직, k8s 호출, DB 액세스 | k8s control 클러스터 Pod |
| App DB (Postgres) | 템플릿/릴리스 메타 + 세션 | k8s Pod 또는 managed Postgres |
| OIDC Provider | 사용자 인증 | 외부 (Google/Keycloak 등) |
| Target k8s Clusters (N) | 실제 배포 대상 | 각 환경 |

### 4.2 주요 흐름 4가지

**① 로그인**
```
Browser ──click "Login"──▶ Next.js /auth/login
Next.js ──redirect──▶ OIDC /authorize (PKCE)
OIDC    ──redirect back with code──▶ Next.js /auth/callback
Next.js ──token exchange──▶ OIDC /token
Next.js ──store id_token + refresh_token in DB session──▶ Postgres
Next.js ──Set-Cookie (httpOnly, SameSite=Lax, session_id)──▶ Browser
```

**② 템플릿 CRUD (관리자)**
```
Browser ──fetch /api/v1/templates──▶ Next.js BFF
Next.js ──read session, get id_token──▶ Postgres (sessions)
Next.js ──GET /v1/templates with Bearer──▶ Go API
Go API  ──validate token, check admin group claim──▶
Go API  ──SELECT/INSERT/UPDATE──▶ Postgres (templates, template_versions)
Go API  ──json response──▶ Next.js ──json response──▶ Browser
```

**③ 배포 (Release 생성)**
```
Browser ──POST /api/v1/releases──▶ Next.js BFF ──▶ Go API
Go API  ──render template (resources + values)──▶ final YAML
Go API  ──BEGIN TX──▶ Postgres
         ├─ INSERT INTO releases (..., rendered_yaml)
         └─ k8s API Server.Apply(yaml) with user's id_token
             ├─ k8s RBAC: 사용자가 Deployment create 가능? → 승인/거부
             └─ 성공 시 라벨 `kubeport.io/release=<name>` 적용
        ──COMMIT──▶
Go API  ──response──▶ Browser
```

**④ 상태 조회**
```
Browser ──GET /api/v1/releases/:id──▶ Next.js BFF ──▶ Go API
Go API  ──SELECT release메타──▶ Postgres
Go API  ──k8s API: list pods with label selector──▶ k8s API
Go API  ──k8s API: list events with involvedObject selector──▶ k8s API
Go API  ──merge DB meta + live k8s state, abstract terms──▶ Browser
```

### 4.3 경계 원칙

- Go API는 **id_token을 그대로 k8s에 포워딩**. k8s RBAC가 최종 판정.
- App DB는 **k8s 상태를 캐시하지 않음**. 리소스 상태는 항상 라이브.
- Next.js Route Handler는 **"인증 쿠키 관리 + 얇은 프록시"** 만. 비즈니스 로직 금지.
- 사용자 OIDC 토큰은 **Next.js 서버 측 쿠키(httpOnly)** 에만. 브라우저 JS가 접근 불가.

---

## 5. 기술 스택

### 5.1 백엔드 (Go)

| 영역 | 선택 | 이유 |
|------|------|------|
| 언어 | Go | k8s 생태계 표준, client-go 성숙 |
| HTTP | Gin (또는 Echo) | 표준 선택, 미들웨어 풍부 |
| k8s 클라이언트 | `client-go` | 공식, Watch/Informer 성숙 |
| OIDC 검증 | `coreos/go-oidc` | 표준 OIDC provider |
| DB driver | `jackc/pgx` (prod) / `mattn/go-sqlite3` (dev) | 표준 |
| DB 마이그레이션 | `ariga.io/atlas` | 선언적 스키마 |
| ORM | `sqlc` | 타입 안전, 런타임 오버헤드 없음 |
| 테스트 | Go 표준 `testing` + `testify` | 표준 |

### 5.2 프론트엔드 (Next.js)

| 영역 | 선택 | 이유 |
|------|------|------|
| 프레임워크 | Next.js 15 (App Router) | BFF 패턴 지원, `output: 'standalone'` 로 컨테이너화 용이 |
| 스타일 | Tailwind + shadcn/ui | 빠른 레이아웃, 접근성 좋은 컴포넌트 |
| YAML 에디터 | Monaco (`@monaco-editor/react`, `dynamic import`) | VSCode 엔진, YAML/JSON schema 지원 |
| 폼 | React Hook Form + Zod | ui-spec → 동적 폼에 적합 |
| OIDC 클라이언트 | `openid-client` | Node 환경 표준 |
| 쿠키/세션 | `iron-session` 또는 커스텀 | httpOnly 쿠키 관리 |
| 상태 관리 | TanStack Query | 서버 상태 캐싱/refetch |
| 테스트 | Vitest + Playwright (E2E) | Next.js 권장 |

### 5.3 DB

- **개발**: SQLite (단일 파일, 설치 불필요)
- **운영**: PostgreSQL 16+
- 주요 스키마 차이점 (array, jsonb 등)은 atlas로 양쪽에 포터블하게 정의.
- `refresh_token` 등 민감 컬럼은 **앱 레벨 AES-GCM 암호화** 후 저장.

### 5.4 배포

- 백엔드: Docker multi-stage build → Helm chart → k8s Pod
- 프론트엔드: Next.js `output: 'standalone'` 빌드 → Docker multi-stage → **같은 Helm chart 내 별도 Deployment + Service**. 단일 Ingress 에서 path 기반 라우팅 (`/api/*` → backend, 그 외 → frontend). 근거: [ADR 0001](../../decisions/0001-frontend-deployment-helm-over-vercel.md).
- Postgres: MVP에선 Helm chart 내 StatefulSet, 운영은 managed DB 권장 (RDS, CloudSQL 등)

### 5.5 레포 구조

```
kubeport/
├── backend/                    # Go
│   ├── cmd/server/             # main
│   ├── internal/
│   │   ├── api/                # Gin handlers
│   │   ├── auth/               # OIDC 검증
│   │   ├── k8s/                # client-go 래퍼
│   │   ├── template/           # render 로직
│   │   ├── store/              # sqlc 생성 코드
│   │   └── model/
│   ├── migrations/             # atlas
│   └── go.mod
├── frontend/                   # Next.js
│   ├── app/
│   │   ├── (auth)/             # 로그인 콜백
│   │   ├── api/                # BFF Route Handlers
│   │   ├── catalog/
│   │   ├── releases/
│   │   └── templates/
│   ├── components/
│   ├── lib/
│   └── package.json
├── deploy/
│   ├── helm/                   # Helm chart
│   └── docker/                 # Dockerfile
└── docs/
```

---

## 6. 데이터 모델

### 6.1 ER 개요

```
users ─┐                                 ┌─ template_versions (버전 불변)
       ├─owns─▶ templates ─current_ver──▶│
       └─creates─▶ releases ◀─version──── │
                     │
                     └─in──▶ clusters
                     
sessions ──(logged in)──▶ users
```

### 6.2 테이블 스키마

#### `users`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| oidc_subject | text UNIQUE NOT NULL | OIDC `sub` |
| email | text | |
| display_name | text | |
| first_seen_at | timestamptz NOT NULL | |
| last_seen_at | timestamptz NOT NULL | |

#### `clusters`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| name | text UNIQUE NOT NULL | slug (`dev`, `staging`, `prod`) |
| display_name | text | |
| api_url | text NOT NULL | k8s API 서버 |
| ca_bundle | text | 사설 CA 지원 |
| oidc_issuer_url | text NOT NULL | 클러스터가 신뢰하는 issuer |
| default_namespace | text | UI 프리필 |
| created_at / updated_at | timestamptz NOT NULL | |

#### `templates`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| name | text UNIQUE NOT NULL | slug (`web-service`) |
| display_name | text NOT NULL | "Web Service" |
| description | text | |
| tags | text[] | |
| owner_user_id | uuid FK users NOT NULL | |
| current_version_id | uuid FK template_versions NULLABLE | 최신 published |
| created_at / updated_at | timestamptz NOT NULL | |

#### `template_versions`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| template_id | uuid FK templates NOT NULL | |
| version | integer NOT NULL | 1, 2, 3... |
| resources_yaml | text NOT NULL | |
| ui_spec_yaml | text NOT NULL | |
| metadata_yaml | text | |
| status | text NOT NULL | `draft` / `published` / `deprecated` |
| notes | text | changelog |
| created_by_user_id | uuid FK users NOT NULL | |
| created_at | timestamptz NOT NULL | |
| published_at | timestamptz NULLABLE | |

- UNIQUE `(template_id, version)`
- Partial unique: draft가 템플릿당 최대 1개

#### `releases`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| name | text NOT NULL | 사용자 지정 |
| template_version_id | uuid FK template_versions NOT NULL | |
| cluster_id | uuid FK clusters NOT NULL | |
| namespace | text NOT NULL | |
| values_json | jsonb NOT NULL | 사용자가 폼에서 입력한 값 |
| rendered_yaml | text NOT NULL | 마지막 apply된 최종 YAML (감사용) |
| created_by_user_id | uuid FK users NOT NULL | |
| created_at / updated_at | timestamptz NOT NULL | |

- UNIQUE `(cluster_id, namespace, name)`

#### `sessions`
| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | 쿠키에 실리는 값 |
| user_id | uuid FK users NOT NULL | |
| id_token_encrypted | text NOT NULL | AES-GCM 암호화 |
| refresh_token_encrypted | text NULLABLE | 동일 암호화 |
| id_token_exp | timestamptz NOT NULL | silent refresh 판단 |
| created_at | timestamptz NOT NULL | |
| expires_at | timestamptz NOT NULL | 세션 최대 수명 (예: 24h) |

### 6.3 주요 인덱스

- `releases(created_by_user_id)` — "내 릴리스"
- `releases(cluster_id, namespace)` — 클러스터·ns별 조회
- `template_versions(template_id, version DESC)` — 버전 목록
- `sessions(expires_at)` — 만료 정리

### 6.4 k8s 리소스 라벨/어노테이션 규약

모든 릴리스가 생성하는 k8s 리소스에 아래를 자동 부착:

```yaml
metadata:
  labels:
    kubeport.io/managed: "true"
    kubeport.io/release: "<releases.name>"
    kubeport.io/template: "<templates.name>"
    kubeport.io/template-version: "<template_versions.version>"
  annotations:
    kubeport.io/release-id: "<releases.id>"
    kubeport.io/applied-by: "<users.email>"
    kubeport.io/applied-at: "<RFC3339 timestamp>"
```

라벨 기반 셀렉터로:
- 릴리스의 리소스 전체 조회: `kubeport.io/release=my-api`
- 릴리스 삭제: 같은 셀렉터로 `kubectl delete`
- 고아 리소스 탐지: 라벨은 있으나 DB에 없는 릴리스

---

## 7. API

### 7.1 전체 경계

```
Browser ──▶ Next.js Route Handler (k8s Pod)
             ├─ /auth/*                 세션/OIDC 콜백
             └─ /api/v1/*               Go API 프록시
Next.js ──▶ Go API (k8s Pod)
             └─ /v1/*                   비즈니스 로직
```

### 7.2 Next.js Route Handlers

| Method | Path | 역할 |
|--------|------|------|
| GET | `/auth/login` | OIDC `authorize` 리다이렉트 (PKCE) |
| GET | `/auth/callback` | OIDC code 교환 → 세션 생성 → Set-Cookie |
| POST | `/auth/logout` | 세션 파기 |
| `*` | `/api/v1/*` | Go API로 프록시 (쿠키→Bearer 변환) |

### 7.3 Go API 엔드포인트 (`/v1`)

모두 `Authorization: Bearer <id_token>` 필요. `/healthz` 제외.

**시스템**
```
GET    /healthz                              → 200 OK (readiness probe)
GET    /v1/me                                → 현재 사용자 (토큰 + users 캐시)
```

**클러스터** (관리자만 쓰기)
```
GET    /v1/clusters                          → 목록
POST   /v1/clusters                          → 등록
GET    /v1/clusters/:id                      → 상세
PUT    /v1/clusters/:id                      → 수정
DELETE /v1/clusters/:id                      → 제거
GET    /v1/clusters/:id/namespaces           → 사용자 접근 가능 ns (RBAC 체크)
```

**템플릿** (관리자만 쓰기)
```
GET    /v1/templates                         ?tag=web&search=X   — 카탈로그
POST   /v1/templates                         템플릿 + v1 draft 생성
GET    /v1/templates/:name                   메타 + 최신 published
PUT    /v1/templates/:name                   메타 수정
DELETE /v1/templates/:name                   삭제 (활성 릴리스 없을 때만)

GET    /v1/templates/:name/versions          버전 목록
POST   /v1/templates/:name/versions          새 draft
GET    /v1/templates/:name/versions/:v       버전 상세
PUT    /v1/templates/:name/versions/:v       draft 수정
POST   /v1/templates/:name/versions/:v/publish     → published 전환
POST   /v1/templates/:name/versions/:v/deprecate   → deprecated 표시

POST   /v1/templates/:name/render            { version, values } → 렌더된 YAML (미리보기, apply 안 함)
```

**릴리스**
```
GET    /v1/releases                          ?cluster=dev&namespace=X&owner=me
POST   /v1/releases                          { template, version, cluster, namespace, name, values }
                                             → DB 기록 + k8s apply
GET    /v1/releases/:id                      메타 + 라이브 상태 조인
PUT    /v1/releases/:id                      { values?, version? } → re-apply
DELETE /v1/releases/:id                      k8s에서 라벨 셀렉터 삭제 + DB row 삭제

GET    /v1/releases/:id/status               추상 요약
GET    /v1/releases/:id/instances            인스턴스(파드) 추상 뷰
GET    /v1/releases/:id/events               k8s 이벤트 (라벨 셀렉터 필터)
GET    /v1/releases/:id/logs                 SSE, ?instance=all|<pod>&tail=100
```

### 7.4 에러 포맷 (RFC 7807 기반)

```json
{
  "type": "https://kubeport.io/errors/rbac-denied",
  "title": "Permission denied",
  "status": 403,
  "detail": "User alice@company.com cannot create Deployment in namespace team-beta",
  "cluster": "dev",
  "request_id": "req_abc123"
}
```

에러 타입 모음 (초기):
- `validation-error` (400) — 폼 검증 실패
- `unauthenticated` (401) — 토큰 누락/만료
- `rbac-denied` (403) — k8s RBAC 거부
- `not-found` (404)
- `conflict` (409) — 릴리스 이름 중복 등
- `k8s-error` (502) — k8s API 실패 (원본 메시지 포함)

### 7.5 SSE 로그 스트리밍

`GET /v1/releases/:id/logs`
- `Content-Type: text/event-stream`
- k8s API: `GET .../pods/{pod}/log?follow=true&tailLines=100`
- Go는 k8s 응답을 읽어 SSE 이벤트로 릴레이
- 복수 인스턴스: goroutine N개, 각 라인에 `instance` 필드 추가

```
event: log
data: {"instance":"my-api-abc12","level":"info","message":"Started server","ts":"..."}

event: log
data: {"instance":"my-api-def34","level":"warn","message":"Auth failed","ts":"..."}
```

### 7.6 OpenAPI Spec

`swaggo/swag` 또는 `kin-openapi`로 Go 코드에서 OpenAPI 3 spec 자동 생성. 빌드 시 `frontend/lib/api-types.ts`로 `openapi-typescript` 컴파일. **스펙이 소스 오브 트루스**.

---

## 8. 핵심 사용자 흐름 시나리오

### 8.1 관리자: 새 템플릿 생성 → publish

1. `Templates` 페이지에서 `+ New Template` 클릭 → `web-service` 이름 입력
2. YAML 모드에서 `resources.yaml` 붙여넣기 (기존 Deployment.yaml)
3. UI 모드로 전환 → 트리에서 `replicas`, `image`, `memory` 체크
4. 가운데 패널에서 각 필드의 한국어 라벨/타입/검증 입력
5. 오른쪽 미리보기에서 사용자가 볼 폼 확인
6. `Save draft` → `Publish v1`
7. 카탈로그에 노출됨

### 8.2 사용자: 배포 → 상태 조회 → 로그

1. 카탈로그에서 `Web Service` 카드 → `배포` 클릭
2. 폼에서 릴리스 이름 `my-api`, 인스턴스 3, 이미지 `nginx:1.25`, 메모리 256Mi 입력 → `배포`
3. `내 릴리스` 로 이동, `my-api` 행이 나타남 (상태 "배포 중")
4. 2분 후 "정상" 으로 바뀜. 상세 페이지 클릭
5. 개요 탭: 3/3 준비됨, 접근 URL 표시
6. 로그 탭: 실시간 스트리밍 시작

### 8.3 사용자: 업데이트 가능 알림 → 마이그레이션

1. 관리자가 `web-service` v3 publish (liveness probe 추가)
2. `내 릴리스`에서 `my-api` 행에 "업데이트 가능 v2 → v3" 뱃지
3. 상세 페이지 → `v3로 업데이트` 버튼 → 폼 표시 (현재 값 유지, 추가된 필드만 기본값)
4. `업데이트` → re-apply. k8s가 probe 추가된 리소스로 롤링 업데이트

### 8.4 관리자: draft 편집 → 취소

1. 관리자가 v3 draft 편집 중
2. `Discard draft` 클릭 → 확인 모달 → 삭제
3. 기존 published v2는 그대로, 릴리스 영향 없음

---

## 9. UI 화면

브레인스토밍 단계에서 4개 목업 생성 (`.superpowers/brainstorm/.../content/` 세션 휘발성):

1. **아키텍처 개요** — 컴포넌트 + 4개 흐름
2. **템플릿 해부도** — resources.yaml + ui-spec.yaml ↔ 사용자 폼 매핑
3. **관리자 템플릿 편집기** — YAML 모드 (2-pane Monaco) + UI 모드 (트리 + 메타 + 라이브 미리보기)
4. **사용자 화면** — 카탈로그 카드 + 내 릴리스 테이블 + 릴리스 상세 (개요 탭 + 로그 탭)

구현 단계에서 고정 mockup 파일이 필요하면 `docs/mockups/`로 복사 예정.

---

## 10. 보안과 신뢰 모델

- **신뢰 소스**: OIDC provider가 유일. k8s RBAC가 최종 권한 판정.
- **토큰 저장**: id_token/refresh_token은 DB(`sessions`)에 AES-GCM 암호화. 쿠키에는 세션 ID(무의미 uuid)만.
- **토큰 전파**: Next.js BFF → Go API까지 `Authorization: Bearer`. Go → k8s 도 동일.
- **브라우저 노출**: 토큰은 JS로 접근 불가 (httpOnly 쿠키).
- **CORS**: Go API는 Next.js 서버 origin만 허용. 브라우저가 직접 Go API 호출 불가.
- **CSRF**: SameSite=Lax 쿠키 + `Origin` 헤더 체크 (POST/PUT/DELETE).
- **암호화 키 관리**: AES 키는 환경변수 또는 k8s Secret. Helm chart values에서 설정.
- **감사**: 모든 쓰기 작업은 `applied-by` annotation으로 k8s 쪽에 기록. v2에서 `audit_log` 테이블 추가 예정.

---

## 11. 배포 모델

### 11.1 백엔드 (k8s에 설치)

```
helm repo add kubeport https://...
helm install kubeport kubeport/kubeport \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientID=... \
  --set db.kind=postgres \
  --set db.host=postgres.example.com \
  --set appEncryptionKey=base64:...
```

Helm chart가 포함하는 것:
- `Deployment` (backend) — Go API 서버 (수평 확장 가능, stateless)
- `Deployment` (frontend) — Next.js standalone Node 서버 (수평 확장 가능, stateless)
- `Service` × 2 — backend / frontend 내부 노출
- `Ingress` — 단일 호스트, path 기반 라우팅 (`/api/*` → backend Service, 그 외 → frontend Service)
- `ServiceAccount` + `ClusterRole` — 자체 권한 (리소스 생성 권한 없음, 메타데이터 읽기만)
- `Secret` — OIDC client secret, DB credential, AES 키, `SESSION_ENCRYPTION_KEY`
- `ConfigMap` — 비민감 환경변수 (`GO_API_BASE_URL=http://kubeport-backend:8080`, `NEXT_PUBLIC_APP_NAME`, `OIDC_ISSUER` 등)
- `StatefulSet` for Postgres (optional, `db.embedded=true` 시)

### 11.2 프론트엔드 (Helm chart 에 통합)

- **이미지 빌드**: Next.js `output: 'standalone'` + Docker multi-stage. 최종 이미지는 `node:*-alpine` 위에 `.next/standalone` + `public/` + `.next/static` 만 담아 경량화.
- **런타임**: `Deployment` (replicas 조정 가능), readinessProbe `/api/health` (Next.js Route Handler).
- **Backend 통신**: 클러스터 내부 Service DNS 로 접근 → `GO_API_BASE_URL=http://kubeport-backend:8080`. public internet 을 거치지 않음.
- **환경변수** (ConfigMap / Secret):
  - `NEXT_PUBLIC_APP_NAME`, `GO_API_BASE_URL` (ConfigMap)
  - `OIDC_ISSUER`, `OIDC_CLIENT_ID` (ConfigMap)
  - `OIDC_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `DB_URL` (Secret)
- **세션 저장소**: Next.js BFF 도 Postgres 에 세션을 저장한다. backend 와 **같은 Postgres** 를 공유 (같은 클러스터 내부 Service DNS 로 접근) → 별도 DB 인스턴스 불필요.
- **PR preview deployment** 는 MVP 범위 밖. 로컬 docker-compose 또는 staging 클러스터 배포로 대체.

근거와 포기한 대안(Vercel)의 전체 논의는 [ADR 0001](../../decisions/0001-frontend-deployment-helm-over-vercel.md) 참조.

### 11.3 첫 번째 설치 플로우 (부트스트랩)

Admin 그룹 클레임을 가진 첫 사용자가 로그인 후:
1. `Clusters` 탭 → `+ Add cluster` → API URL, OIDC issuer 입력
2. `Templates` 탭 → 첫 템플릿 작성
3. 다른 사용자에게 앱 URL 공유 → 그들도 SSO로 로그인

---

## 12. 범위

### 12.1 MVP (이번 스펙 대상)

- 로그인 (OIDC, Auth Code + PKCE)
- 클러스터 등록/목록
- 템플릿 CRUD (YAML 모드 + UI 모드)
- 템플릿 버저닝 (draft/published/deprecated)
- 카탈로그 뷰
- 릴리스 생성/수정/삭제
- 릴리스 목록 + 상세 (개요/로그/활동/설정 탭)
- SSE 로그 스트리밍
- 업데이트 가능 알림 + 마이그레이션
- 추상화된 상태 표시 + "원본 k8s 용어 보기" 토글

리소스 범위: Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, ConfigMap, Secret, PersistentVolumeClaim (+ 관찰: Pod, Event, Log).

### 12.2 v1.1

- 관리자 수동 CRD 등록 (OpenAPI schema로 폼/뷰 자동 생성)
- 페이지네이션 (릴리스/템플릿 목록)
- 릴리스 히스토리 (values 변경 diff)
- 템플릿 필드: `secret`, `conditional`
- 클러스터별 informer 캐시 (수백 릴리스 시 성능)

### 12.3 v2+

- Git 리포 기반 템플릿 저장 (Backstage 스타일)
- Helm chart 임포트 (placeholder → ui-spec 자동 추출)
- 팀 개념 + 세분화된 RBAC
- Audit log API + UI
- 웹훅 / 알림
- 관리자용 "Level 3": 템플릿에 "허용된 조작" 선언 (restart, scale 등)
- BYOK (kubeconfig 업로드) 폴백 인증

---

## 13. 열린 질문 (구현 중 결정)

1. **템플릿 삭제 시 활성 릴리스 처리**: "삭제 차단" 이 기본. "강제 삭제 후 릴리스 orphan 허용"도 지원할지?
2. **실패한 apply 롤백**: 3개 리소스 중 2개 성공·1개 실패 시 롤백할지, 부분 성공 상태로 둘지? 현재 가정은 **best-effort + 에러 표시, 수동 조치**.
3. **릴리스 삭제 시 Persistent Volume 정리**: PVC를 자동 삭제할지 "수동 정리" 유도할지? 현재 가정은 **자동 삭제 + 경고**.
4. **동시 편집 충돌**: 두 관리자가 같은 draft 편집 중일 때 Last-Write-Wins? Optimistic locking (`If-Match` ETag)?
5. **템플릿 이름 변경 가능?** 현재 가정은 **`name`은 변경 불가, `display_name`만 수정**.

이 질문들은 구현 단계(implementation plan)에서 ADR로 확정.

---

## 14. 다음 단계

1. 이 스펙을 사용자가 리뷰
2. 피드백 반영 후 버전 0.2로 업데이트
3. 승인 시 `writing-plans` 스킬 호출 → `docs/superpowers/plans/2026-04-16-initial-implementation.md` 생성
4. 구현은 plan의 단계별 체크포인트 방식으로 진행
