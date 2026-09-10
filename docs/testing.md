# 테스트 전략

> 이 문서는 kubeport 의 테스트 레이어 분리, 사전 조건, 관례를 정의한다.
> CLAUDE.md 의 `## 테스트` 섹션과 쌍을 이룸 — CLAUDE.md 가 요약본, 이 문서가 상세본.

## 1. 철학

- **TDD 를 1 등급으로 유지한다.** 플랜의 각 태스크는 "실패하는 테스트 작성 → 구현 → 통과" 순서를 따른다.
- 테스트는 **프로덕션 코드와 같은 품질**로 작성한다 — 매직 넘버 금지, 실패 메시지가 디버깅 가능해야 한다.
- **레이어를 섞지 않는다.** 한 테스트는 한 레이어의 계약만 검증한다 (단위 테스트가 DB 에 접속하지 않고, 통합 테스트가 HTTP 핸들러를 돌리지 않는 식).

## 2. 레이어

| 레이어 | 외부 의존 | 위치 예 | 실행 속도 | 목적 |
|--------|-----------|---------|-----------|------|
| **Unit** | 없음 | `internal/api/routes_test.go` (`TestHealthz`), 향후 `internal/template/*_test.go` (render 순수 로직) | ms | 순수 함수·라우팅·렌더링 로직 검증 |
| **Integration** | `deploy/docker/docker-compose.yml` (postgres, 향후 dex) | `internal/store/store_test.go`, 향후 `internal/auth/*_test.go` | 10ms–1s | 외부 SUT 하나(DB, OIDC, k8s)와의 계약 검증 |
| **e2e** | Full stack — compose + Go API + Next.js + kind 클러스터 | 향후 `test/e2e/` (Task 22) | 수십 초 | 사용자 시나리오 흐름 검증 |

**원칙:**
- 한 패키지에 단위+통합 테스트가 공존해도 괜찮지만, 통합 테스트는 **외부 SUT 접속 실패 시 `t.Skip`** 을 호출해야 한다 (아직 미구현 — §6 참조).
- k8s 가 필요한 테스트(Task 12+)는 `kind` / `k3d` 를 기대한다. CI 는 `setup-kind-action` 을 쓸 계획(향후 Task 23 논의).

## 3. 사전 조건

### 3.1 Unit 만 실행

준비물 없음.
```bash
cd backend && go test -short ./...
```
> `-short` 플래그 규약은 **현재 미적용**. 통합 테스트에 `if testing.Short() { t.Skip() }` 를 도입하면 즉시 작동 (§6 TODO).

### 3.2 Integration 실행 (현재 기본)

```bash
docker compose -f deploy/docker/docker-compose.yml up -d   # postgres + dex
cd backend/migrations && atlas schema apply --env local --auto-approve   # 최초 1회 또는 schema 변경 후
cd backend && go test ./...
```

> 위 명령은 공유 DB `kubeport` 를 쓴다. **다른 세션·워크트리가 같은 머신에서 테스트를 돌릴 수 있다면 §3.4 의 세션별 DB 를 먼저 만든다.**

컴포즈 중단:
```bash
docker compose -f deploy/docker/docker-compose.yml down        # 데이터 유지
docker compose -f deploy/docker/docker-compose.yml down -v     # pgdata 볼륨까지 삭제
```

### 3.3 e2e (Task 22 에서 도입)

미정. `test/e2e/` 안에 compose 기반 플로우 러너 + kind 클러스터 부트스트랩 예정.

### 3.4 세션·워크트리별 테스트 DB (`scripts/test-db.sh`)

**왜 필요한가.** 통합 테스트는 모두 `TEST_DATABASE_URL`(없으면 공유 DB `kubeport`)에 실제 행을 남기고, 정리는 **이름 패턴**으로 한다:

- `internal/api/main_test.go` 의 `TestMain` 이 스위트가 끝나면 이름이 `-[0-9]{6}\.[0-9]{6}$`(`HHMMSS.micros` 접미사)로 끝나는 `releases`·`template_versions`·`templates`·`clusters`·`teams`·`users` 를 **그 DB 전체에서** 지운다.
- `internal/store` 의 픽스처(`test-sub-<stamp>`, `rollback-<stamp>` …)도 같은 접미사라 이 패턴에 걸린다.
- `cmd/seed-demo/templates_test.go` 는 **고정된** 데모 템플릿 이름을 지우고 다시 만든다.

`go test -p 1` 은 **한 번의 실행 안에서** 패키지를 직렬로 돌릴 뿐이다. 이 머신에서 Claude 세션 여러 개가 같은 compose postgres 로 동시에 테스트를 돌리면, A 세션의 `internal/api` 가 끝나는 순간 B 세션이 방금 만든 클러스터·템플릿을 지운다 → B 는 404·FK 오류로 **간헐적으로** 깨진다. 재현이 어렵고 코드와 무관한 빨간불이라 가장 비싼 종류의 실패다.

**사용법** — 세션을 시작할 때 한 번:

```bash
eval "$(scripts/test-db.sh)"        # kubeport_test_<워크트리 디렉터리명> 생성 + 스키마 적용 + TEST_DATABASE_URL export
cd backend && go test -p 1 ./internal/store/...
```

| 명령 | 동작 |
|------|------|
| `scripts/test-db.sh [name]` | DB `kubeport_test_<name>` 이 없으면 만들고 스키마 적용(멱등 — 최신이면 no-op). stdout 에는 `export TEST_DATABASE_URL=...` **한 줄만**, 안내는 stderr. `name` 생략 시 워크트리 디렉터리명을 소문자·영숫자·밑줄로 정규화해 쓴다. 63바이트 식별자 한도를 넘으면 잘라 체크섬을 붙인다 |
| `eval "$(scripts/test-db.sh --drop [name])"` | 그 DB(와 atlas dev DB)를 삭제하고 `TEST_DATABASE_URL` 을 unset. **공유 DB `kubeport` 는 이름 규칙상 대상이 될 수 없고, 추가로 명시적 가드가 있다** |
| `scripts/test-db.sh --list` | 이 postgres 에 남아 있는 세션별 DB 목록 — 지운 워크트리의 DB 청소용 |

- **스키마 적용은 CI 와 같은 경로다.** `backend/migrations/atlas.hcl` 의 `env "local"` + `schema.hcl` 을 그대로 쓰고 `--var url=…` 로 대상만 바꾼다. `url`·`dev` 가 변수가 됐지만 기본값이 예전 값이라 CI·`up.sh` 의 `atlas schema apply --env local` 은 그대로다.
- **한 가지 차이 — atlas dev DB.** CI 의 `docker://postgres/16/dev` 는 적용마다 컨테이너를 띄우는데, 일부 Docker Desktop(Windows) 호스트에서는 atlas 가 호스트 LAN IP 로 붙으려다 ~70초 뒤 타임아웃한다(2026-09-10 이 머신에서 재현). 그래서 스크립트는 같은 compose postgres(같은 16 메이저) 안에 세션별 빈 DB `kubeport_atlasdev_<name>` 을 dev DB 로 쓴다. 적용 결과는 같고 3초 안에 끝난다.
- **컴포즈가 안 떠 있으면** 즉시 실패하고 `docker compose ... up -d` 를 안내한다. psql 은 컨테이너 안에서 돌기 때문에 호스트에 psql 이 없어도 된다(Git Bash·WSL·macOS 동일).
- **워크트리를 지우기 전에 `--drop`.** 잊었으면 `--list` 로 찾아 `scripts/test-db.sh --drop <name>`.
- 세션별 DB 에서도 **`-p 1` 은 여전히 필요하다** — 같은 세션 안의 `internal/api` 와 `internal/store` 충돌(§6)은 DB 를 나눠도 그대로다.
- CI 는 러너마다 postgres 가 따로라 이 스크립트를 쓰지 않는다.

### 3.5 반복 규칙 — 전체 스위트는 푸시 직전 1회

개발 세션 기록을 보면 수정 반복 중에 전체 스위트를 너무 자주 돌렸다: **vitest 전체 42회, 평균 65초** — 파일 단위 실행은 평균 **11초**. **go test 전체도 43회**. 전체 한 번이 파일 단위 여섯 번 값이고, 공유 DB 를 쓰던 시절에는 그 43회가 전부 다른 세션과 충돌할 기회였다.

- **고치는 동안은 파일·패키지·테스트 단위로 돈다.**
  ```bash
  cd frontend && pnpm vitest run src/components/Foo.test.tsx
  cd backend  && go test ./internal/api -run TestClusters_Register
  ```
- **전체 스위트(`pnpm test`, `go test -p 1 ./...`)는 푸시 직전 1회.** 그 사이 바뀐 게 테스트 대상 밖으로 번졌는지 확인하는 용도다.
- **CI 가 어차피 전체를 돈다** (`.github/workflows/ci.yml` — backend·frontend·audit·hooks). 로컬 전체 실행은 CI 를 대신하는 게 아니라 "빨간 CI 로 왕복하는 비용" 을 줄이는 한 번이면 충분하다.

## 4. 환경 변수

| 이름 | 기본값 | 목적 |
|------|--------|------|
| `TEST_DATABASE_URL` | `postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable` | 통합 테스트 DB DSN. CI 에서 주입 가능. 로컬에서 세션이 여럿이면 `eval "$(scripts/test-db.sh)"` 로 세션별 DB 를 가리킨다 (§3.4) |
| `TEST_DEX_ISSUER` (예정, Task 7) | `http://localhost:5556` | OIDC 테스트용 dex 이슈어 |
| `TEST_KUBECONFIG` (예정, Task 12) | `$HOME/.kube/config` | k8s 테스트용 kubeconfig |
| `OIDC_ISSUER` | `http://localhost:5556` | `internal/auth` 가 붙을 dex. HTTPS dex 는 `https://host.docker.internal:5556` |
| `OIDC_CA_FILE` | (없음) | 자체서명 dex 인증서 경로 (`deploy/docker/certs/dex.crt`) |
| `KBP_REQUIRE_DEX` | (없음) | `1` 이면 dex 미기동 시 skip 대신 FAIL. **CI 전용** — 없으면 조용히 skip 되어 초록이 되므로 |
| `SKIP_OIDC` | (없음) | 값이 있으면 dex 기반 테스트를 무조건 skip. `KBP_REQUIRE_DEX=1` 과 함께 주면 에러 |

## 5. 관례

### 5.1 DB 유니크 충돌 회피
통합 테스트는 트랜잭션 롤백이 아니라 **실제 INSERT** 를 남긴다. 유니크 제약(예: `users.oidc_subject`, `clusters.name`)을 가진 컬럼은 매 실행 고유한 값이 필요:

```go
stamp := time.Now().Format("150405.000000")   // HHMMSS.microseconds
oidcSubject := "test-sub-" + stamp
clusterName  := "test-" + stamp
```
초 단위(`150405`)만 쓰면 같은 초 내 재실행 시 충돌한다. 마이크로초 자리까지 포함한다.

### 5.2 `pgtype.Text` 래퍼

`backend/internal/store/store_test.go:pgText(s string)` — `pgtype.Text{String: s, Valid: true}` 로 래핑. sqlc 가 생성한 NULL 허용 컬럼 파라미터에 문자열을 넣을 때 사용.

### 5.3 테스트 네이밍
- Go: `TestVerbNoun` (예: `TestUpsertUser`, `TestInsertClusterAndTemplate`). 하위 케이스는 `t.Run("case name", ...)`.
- 통합 테스트 파일은 대상 패키지의 `_test.go` 안에 두고, external test package(`package xxx_test`) 를 써서 API 경계로 접근한다.

### 5.4 tear-down
- DB: 현재는 정리하지 않는다(유니크 키가 매번 다르므로 쌓여도 무해). pgdata 는 `down -v` 로 초기화.
- 향후 k8s: 각 테스트가 고유 네임스페이스에서 생성·삭제를 완결시켜야 한다.

## 6. 알려진 갭 / TODO

- [~] **Integration 테스트 skip 경로 — dex 만 구현.** `internal/auth` 는 `requireDex()`(`verifier_test.go`)가 dex 도달성을 프로브해 skip 하므로, 인증서 없는 새 클론에서도 `go test ./...` 가 초록이다. **postgres 경로는 아직 미구현** — `TEST_DATABASE_URL` 없고 `localhost:5432` 접속 실패 시 `internal/store`·`internal/api` 가 connection error 로 FAIL 한다. 같은 방식(`NewStore` 호출 전 `pgxpool.Ping` 프로브 + `t.Skip`)으로 맞출 것.
- [ ] **`-short` 플래그 미적용.** 모든 통합 테스트에 `if testing.Short() { t.Skip(...) }` 가 없다.
- [x] **CI 파이프라인** — `.github/workflows/ci.yml` (2026-09-09 추가). backend(compose + atlas + `go test -p 1 ./...`, `KBP_REQUIRE_DEX=1`) / frontend(`pnpm typecheck`·`lint`·`test`) / `pnpm audit` / 훅 테스트 4개 job.
- [x] **빌드 태그는 skip 이 아니라 실명(失明)이다** (#121, 2026-09-10). `//go:build` 가 붙은 파일은 컴파일러에게 **안 보이므로**, 조용히 썩고 "Skipped Go tests" 요약에도 안 잡힌다 — skip 과 결정적으로 다른 점이다. `openapi_proxy_test.go` 는 `integration` 태그를 뗐다(`kindAvail()` 이 `testStore(t)` 보다 **먼저** 호출되므로 이 파일의 두 테스트는 postgres 없이도 skip 된다 — 태그 제거가 새 클론을 더 빨갛게 만들지 않는다. 다만 `go test ./...` 전체는 위 `[~]` 항목대로 여전히 컴포즈가 필요하다). `backend/e2e` 는 `TestMain` 이 compose 와 서버를 띄우므로 `e2e` 태그를 유지하되 `go vet -tags=<발견된 태그> ./...` 로 **컴파일만** 검증한다. 태그 목록은 `ci.yml` 이 소스에서 **스캔**한다 — 손으로 적은 목록은 코드에서 멀어지고, 그 드리프트가 #121 의 정체였다.
- [x] **kind 필요 테스트는 playwright.yml 이 실제로 돌린다** (#121). 그전에는 ci.yml 주석이 "playwright.yml 이 게이트" 라고 적어 뒀지만 그 워크플로에 `go test` 가 한 줄도 없었다 — `openapi_proxy`·`internal/k8s` 는 **어디서도 실행된 적이 없다.** 이제 클러스터 등록 직후(시더 앞) `KIND_API`/`KIND_CA`/`DEX_TOKEN` 을 주입해 돌린다.
- [x] **`KBP_REQUIRE_KIND=1` 은 kind 계열 skip 을 실패로 바꾼다** — `KBP_REQUIRE_DEX` 와 같은 논리다. 스스로 skip 하는 테스트는 배선이 끊겨도 초록이라 **게이트가 아니게 된다.** 스위치를 워크플로의 테스트 이름 목록이 아니라 **테스트 코드**(`kindAvail()`, `client_test.go`)에 둔 것이 핵심이다 — 새 kind 테스트는 `kindAvail()` 을 부르는 순간 자동으로 게이트에 들어오고, 이름이 바뀌거나 지워지면 스스로 빠진다. 워크플로에 목록을 두면 그 목록이 또 코드에서 멀어진다.
- [ ] **패키지 병렬 실행 불가.** `internal/api` 의 `TestMain` 이 이름 패턴으로 공유 DB 를 정리하는데 `internal/store` 가 같은 타임스탬프 접미사를 쓴다 → 동시 실행 시 서로의 픽스처를 지운다. CI 는 `-p 1` 로 우회 중이며, 근본 해결은 패키지별 스키마 분리 또는 접미사 네임스페이싱. **세션 간** 충돌(같은 머신의 여러 세션이 공유 DB `kubeport` 를 쓰는 경우)은 `scripts/test-db.sh` 의 세션별 DB 로 해소됐다(§3.4) — 세션 **안의** 패키지 병렬은 여전히 불가.
- [ ] **schema.hcl ↔ schema.sql 드리프트 가드 없음.** atlas 로 regen 후 `git diff --exit-code schema.sql` 을 CI 가 돌려야 한다.

## 7. 태스크별 테스트 프리리퀴짓 매트릭스

플랜(`docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md`) 기준, 각 태스크가 필요로 하는 외부 SUT.

| Task | 레이어 | 외부 의존 | 메모 |
|------|--------|-----------|------|
| 2 Gin /healthz | Unit | 없음 | `TestHealthz` |
| 5–6 sqlc store | Integration | postgres | `TestUpsertUser`, `TestInsertClusterAndTemplate` |
| 7 OIDC verifier | Integration | dex (password grant 로 토큰 발급) | `enablePasswordDB: true` 필수 |
| 8 auth middleware | Integration | dex (또는 테스트용 가짜 JWT signer) | verifier 재사용 |
| 9 clusters API | Integration | postgres | |
| 10 template render | Unit | 없음 | 순수 Go, I/O 없음 |
| 11 template CRUD | Integration | postgres | |
| 12 k8s client | Integration | kind 또는 k3d 클러스터 + dex | **opt-in** (`KUBEPORT_K8S_TEST=1` 제안) |
| 13–14 releases | Integration | kind + postgres | |
| 22 e2e | e2e | 모두 | 별도 디렉터리 |

## 8. Codex Review Gate 와의 관계

세션 Stop 훅에 `/codex:review` 가 연동되어 있다 (`.claude/plugins/.../hooks.json`). 파일 수정이 있는 턴의 종료 시 자동 리뷰가 돈다. 리뷰는 **테스트를 대체하지 않는다** — TDD 로 녹색 / 빨간색을 먼저 확보하고, Codex 리뷰는 그 위에서 디자인·보안·성능 관점을 추가로 본다.
