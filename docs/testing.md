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

컴포즈 중단:
```bash
docker compose -f deploy/docker/docker-compose.yml down        # 데이터 유지
docker compose -f deploy/docker/docker-compose.yml down -v     # pgdata 볼륨까지 삭제
```

### 3.3 e2e (Task 22 에서 도입)

미정. `test/e2e/` 안에 compose 기반 플로우 러너 + kind 클러스터 부트스트랩 예정.

## 4. 환경 변수

| 이름 | 기본값 | 목적 |
|------|--------|------|
| `TEST_DATABASE_URL` | `postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable` | 통합 테스트 DB DSN. CI 에서 주입 가능 |
| `TEST_DEX_ISSUER` (예정, Task 7) | `http://localhost:5556` | OIDC 테스트용 dex 이슈어 |
| `TEST_KUBECONFIG` (예정, Task 12) | `$HOME/.kube/config` | k8s 테스트용 kubeconfig |

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

- [ ] **Integration 테스트 skip 경로 미구현.** `TEST_DATABASE_URL` 없고 `localhost:5432` 접속 실패 시 테스트가 connection error 로 FAIL 한다. `t.Skip("postgres unavailable; set TEST_DATABASE_URL or run compose")` 필요. 빠른 방법은 `store_test.go` 의 `NewStore` 호출 전 `pgxpool.Ping` 프로브 추가.
- [ ] **`-short` 플래그 미적용.** 모든 통합 테스트에 `if testing.Short() { t.Skip(...) }` 가 없다.
- [ ] **CI 파이프라인 부재.** `.github/workflows/` 에 unit 전용 job + integration job(compose 기동) 분리 필요. Task 22/23 에서 다룬다.
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
