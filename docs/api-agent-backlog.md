# API 백로그 — 기계 클라이언트 표면

`ai-reviewer` 페르소나가 제안하는 **신규 API 표면**을 모아 두는 곳이다.
여기 있는 항목은 **버그가 아니다.** 현재 kubeport 에는 사람 브라우저 외의 호출자가 없고,
아래 항목 중 어느 것도 문서화된 계약을 위반하지 않는다.

## 왜 이슈가 아니라 문서인가

2026-09-09 트리아지에서 open 이슈 55건 중 20건이 `reviewer:ai` 였다. 그런데 이 프로젝트의
명제는 "비전문 사용자를 위한 셀프서비스 포털" 이고, 기계 클라이언트는 [Plan 14](../CLAUDE.md) 이후의
로드맵이다. 실사용자도 실제 API 호출자도 없는 상태에서 신규 API 요구가 실제 결함(설치 실패,
데모 진입 불가)과 같은 트래커에 같은 무게로 쌓이면 **우선순위 신호가 사라진다.**

**규칙:**
- `ai-reviewer` 는 신규 API 표면 요구에 대해 **GitHub 이슈를 열지 않는다.** 이 문서에 append 한다.
- 예외 — 이슈로 열어도 되는 것: **이미 문서화된 계약과 실제 동작이 다른 경우.**
  (예: [#74](https://github.com/shyuni4u/kubeport/issues/74) 스펙에 적힌 필터 파라미터가 무시됨,
  [#127](https://github.com/shyuni4u/kubeport/issues/127)·[#128](https://github.com/shyuni4u/kubeport/issues/128)
  `docs/machine-clients.md` 의 계약 구멍)
- 승격 조건: 실제 호출자(MCP 서버, CI 통합, 외부 스크립트)가 생기거나 Plan 14 착수 시,
  이 문서에서 필요한 항목만 이슈로 꺼낸다.

관련: [docs/machine-clients.md](machine-clients.md) — **현재 확정된** 기계 클라이언트 계약.

---

## 항목

우선순위는 "실제 호출자가 생겼을 때 없으면 가장 아픈 것" 순.

### 1. 템플릿 선언적 upsert — `PUT /v1/templates/{name}` (구 #120)

`POST /v1/templates` 는 생성 전용(중복 409)이고 버전 게시·초안 생성은 별개 호출이다. 멱등하게
시드하려는 클라이언트는 `존재? → 소유자 확인 → current_version 이 published 인가 → draft 가 있나 → 없으면 생성`
을 직접 짜야 한다.

**이미 두 번 재구현됐고 실제로 갈라졌다** — 삭제된 `seed.go` 의 `repairVersions`, `cmd/seed-demo/templates.go` 의 `repair`.
첫 판은 "v1 이 draft 인가" 를 물어서, 방문자가 published 버전을 바꾸면 배포 불가 상태를 정상으로 오판했다
([#117](https://github.com/shyuni4u/kubeport/issues/117) 의 근본 원인).

> 자동화가 아니라 **우리 자신의 시더가 이미 이걸 필요로 했다.** 목록에서 가장 근거가 확실한 항목.

### 2. 릴리스 상태 스트림 / 폴링 종료 조건 (구 #57)

SSE 는 `GET /v1/releases/{id}/logs` 하나뿐이고 상태 전이 스트림이 없다. 배포 직후 클라이언트는
폴링 간격을 스스로 정해야 하고 "언제까지 기다리나" 힌트가 응답에 없다.

- 최소안: `GET /v1/releases/{id}` 응답에 `terminal: true|false` + `retry_after_seconds`
- 완전안: `GET /v1/releases/{id}/events` (SSE, status 변경 시에만)

사람 UI 의 "릴리스 상세 자동 갱신 없음"([#8](https://github.com/shyuni4u/kubeport/issues/8))과 같은 뿌리라
사람 쪽을 고칠 때 같이 나온다.

### 3. 삭제의 사전 확인 — `?dry_run=` / 확인 토큰 (구 #76, #139 중복)

`DELETE /v1/releases/{id}` 는 권한 검사 후 곧바로 라벨 셀렉터로 클러스터 리소스를 지우고 DB row 를 지운다.
확인 토큰·이름 재입력·`?dry_run=` 이 전부 없고, 성공 응답 `{"deleted": true, "force": force}` 는
**무엇이 지워졌는지 돌려주지 않아** 사후 대조도 안 된다.

배포 쪽에는 `POST /v1/templates/{name}/render` 라는 안전한 사전 확인 수단이 있는데 파괴적 연산에는 대응물이 없다.
사람 UI 의 브라우저 confirm 은 API 계약이 아니다.

### 4. 멱등키 — `Idempotency-Key` (구 #75)

`CreateRelease` 는 `Idempotency-Key` 도 request id 도 읽지 않는다. 유일한 방어는 DB unique 제약
(`r_name_uq (cluster_id, namespace, name)`)이고, 위반 시 `409 conflict` 에 **기존 릴리스 id 가 없다.**
POST 후 응답 전에 타임아웃/재시도하면 두 번째 호출이 성공도 조회도 못 한다.

중복 제출 방어([#31](https://github.com/shyuni4u/kubeport/issues/31))는 브라우저 안에서만 동작한다.

> 최소 개선: **409 응답에 기존 릴리스 id 를 실어 주기.** 헤더 없이도 재시도가 복구 가능해진다.

### 5. 목록 응답 봉투 — 페이지네이션 메타데이터 (구 #58)

`ListReleases` 는 `limit`/`offset` 을 받지만 응답은 `{"releases": rows}` 뿐 — `total`·`next_offset`·`has_more` 가 없다.
`defaultPageLimit=50` 이라 클라이언트는 `len(rows)==50` 으로 추측해야 하고, 마지막 페이지가 정확히 50건이면 헛 호출한다.
`GET /v1/templates` 는 페이지네이션 파라미터 자체가 없다.

### 6. 배포 전 권한 판정(preflight)의 백엔드 승격 (구 #70)

배포 가능 여부 판정이 전부 프론트엔드에만 있다:
- `frontend/components/RBACCheckPanel.tsx` — kind→(group,resource) 매핑표 10종이 TSX 상수
- 같은 파일 — 3-상태 집계 규칙("확인 실패는 거부가 아니다")
- `frontend/app/catalog/[name]/deploy/DeployClient.tsx` — 렌더된 YAML 파싱해 kind 추출

백엔드 `POST /v1/selfsubjectaccessreview` 는 kind 1건짜리 원시 프록시다. 매핑표가 프론트에만 있으면
[#103](https://github.com/shyuni4u/kubeport/issues/103)(CRD 시 화이트리스트) 같은 문제가 두 곳에서 갈린다.

### 7. ui-spec 을 JSON 으로 노출 + 필드 제약 스키마 (구 #77)

`ListTemplates` 가 `ui_spec_yaml` 을 JOIN 해 목록 1회로 필드 스키마를 주는 것은 좋다. 다만 값이
**YAML 원문 문자열**이라 JSON 만 다루는 호출자는 YAML 파서를 추가해야 한다. 프론트엔드조차 변환을
자체 구현해 뒀다(`frontend/lib/ui-spec-to-zod`). 필드 제약(type/min/max/required/enum)이 어떤 키로
표현되는지 정의한 문서도 없다.

관련: [#136](https://github.com/shyuni4u/kubeport/issues/136) — `Field.Validate` 에 default 절이 없어
type 오타가 검증 없이 통과하는 문제. **이건 실제 버그라 이슈로 남아 있다.**

### 8. MCP 서버 (구 #25)

"web-app 하나 배포해 줘" 를 AI 비서가 대신 수행할 진입점이 없다. 최소 `list_templates` /
`render_template` / `create_release` / `get_release_status` 4개 툴.

**1~7 이 선행되어야 의미가 있다** — 특히 1(upsert)·2(상태)·3(dry-run) 없이 MCP 를 얹으면
에이전트가 확인 없이 지우고 상태를 폴링으로 때우게 된다. v1.1 이후.

---

## 접은 이력

2026-09-09 트리아지에서 아래 이슈를 이 문서로 접고 닫았다:
[#25](https://github.com/shyuni4u/kubeport/issues/25),
[#57](https://github.com/shyuni4u/kubeport/issues/57),
[#58](https://github.com/shyuni4u/kubeport/issues/58),
[#70](https://github.com/shyuni4u/kubeport/issues/70),
[#75](https://github.com/shyuni4u/kubeport/issues/75),
[#76](https://github.com/shyuni4u/kubeport/issues/76),
[#77](https://github.com/shyuni4u/kubeport/issues/77),
[#120](https://github.com/shyuni4u/kubeport/issues/120),
[#139](https://github.com/shyuni4u/kubeport/issues/139) (#76 과 중복).
