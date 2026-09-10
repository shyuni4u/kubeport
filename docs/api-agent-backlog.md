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

## ai-reviewer 비활성화 (2026-09-10)

**`/pr-review` 는 `ai-reviewer` 를 더 이상 띄우지 않는다.** 에이전트 정의(`.claude/agents/ai-reviewer.md`)는
지우지 않았다 — 재개는 `SKILL.md` §2 의 병렬 목록에 이름을 다시 넣는 한 줄이다.

### 왜 껐나

라벨 `reviewer:ai` 이슈 22건의 최종 처분:

| 처분 | 건수 | 번호 |
|---|---|---|
| 고쳐서 종료 | 7 | #23 #24 #34 #56 #81 #82 #83 |
| 기각 (not planned) | 11 | #25 #38 #57 #58 #70 #75 #76 #77 #119 #120 #139 |
| 열림 | 4 | #74 #107 #127 #128 |

적중률 7/22. 기각 11건은 전부 같은 모양이다 — MCP 서버·페이지네이션·멱등키·dry-run 토큰, 즉
**실제 호출자가 없는 상태의 신규 API 표면 요구**다. 위 "왜 이슈가 아니라 문서인가" 규칙을 2026-09-09 에
걸었는데도 그 뒤 6건 중 3건이 여전히 기각됐다. 그 규칙은 매니저 단계에서 거르므로 **걸러지기 전까지의
실행 비용은 이미 다 쓴 뒤**다. 실사용자도 실제 API 호출자도 없는 지금은 시기상조라고 판단했다.

### 껐기 때문에 지금 아무도 안 보는 표면

남은 페르소나 5명은 화면을 본다. 기계 계약을 읽던 건 이 페르소나 하나였다:

- `backend/api/openapi.yaml` 의 `ErrorKind` enum 과 실제 응답의 일치
- `docs/machine-clients.md` 가 가르치는 계약과 실제 동작의 괴리
- SSE 프레임 스키마 (`log` / `ping` / `error` / `end`)

이 손실이 가상이 아니라는 근거: **#82("SSE 인스트림 에러가 다른 스키마 + 에러 후 스트림 미종료")가 이
페르소나에서 나왔고**, `backend/internal/api/release_logs.go` 의 `streamErrorKind` 주석이 아직 `since #82` 를
달고 있다. 2026-09-10 의 #157·#162(로그 탭 무한 재연결, 라이브 실측 53초에 18회)가 그 계약 구멍의
후손이다. #81·#83 도 같은 뿌리이고, CLAUDE.md 가 "에러 계약 완성" 으로 기록한 작업의 절반이 여기서 나왔다.

### TODO — 재개 조건

아래 중 **하나라도** 참이 되면 다시 켠다.

- [ ] 실제 기계 호출자가 생긴다 (MCP 서버, CI 통합, 외부 스크립트 — 아래 "항목" 의 승격 조건과 같다)
- [ ] Plan 14 착수
- [ ] `backend/api/openapi.yaml` 또는 `docs/machine-clients.md` 를 바꾸는 PR 이 나온다 —
      그 PR 한 건에 한해 수동으로 붙인다

재개할 때 같이 할 것:

- [ ] 에이전트 프롬프트에 **"이미 문서화된 계약의 위반만 finding 으로 낸다. 새 엔드포인트·새 파라미터
      요구는 finding 이 아니다"** 를 넣는다 — 기각 11건을 애초에 안 만들게. 지금 규칙은 매니저가 사후에 거른다.
- [ ] 무조건 병렬이 아니라 **diff 가 계약 표면(`backend/api/openapi.yaml`, `docs/machine-clients.md`,
      `backend/internal/api/**`)을 건드릴 때만** 붙이는 조건부 실행으로 바꾼다. 2026-09-10 머지분에
      적용하면 #167(프론트)·#170(문서)은 안 돌고 #168 만 돈다.
- [ ] 열린 채 남은 4건(#74 #107 #127 #128)이 그때까지 살아 있는지 먼저 확인한다.

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

사람 UI 는 [#183](https://github.com/shyuni4u/kubeport/issues/183) 에서 API 변경 없이 먼저 고쳤다 —
릴리스 상세가 `status` 가 `unknown`·`warning` 인 동안 `router.refresh()` 로 스스로 다시 읽는다
(3·5·8·13초 뒤 15초 간격, 5분 뒤 포기). 종료 상태 판정(`healthy`·`error`·stale 이면 멈춤)이
`frontend/components/ReleaseAutoRefresh.tsx` 의 `SETTLING` 상수에만 있으므로, 이 항목의 `terminal`
필드를 만들면 그 상수를 응답값으로 대체해 판정을 한 곳으로 모은다.

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

### 9. 템플릿 태그의 어휘와 제약 — `GET /v1/tags` + `?tag=` 필터 (ai, #110 #111 #112 #130 PR 리뷰에서)

`templates.go` 가 `tags` 를 길이·문자셋 제한 없이 그대로 저장하고 openapi 도 제약을 선언하지
않는다. **스펙과 구현이 일치하므로 계약 위반이 아니다** — 그래서 이슈가 아니라 여기다.

결과적으로 기계 클라이언트는 (a) 어떤 태그가 존재하는지 물어볼 곳이 없고, (b) 전체 목록을 받아
집계해도 그 어휘가 안정적이라는 보장이 없다. `?tag=` 서버 필터도 없다(grep 0건) — 카탈로그의
태그 칩은 프론트가 로드된 템플릿에서 파생한다.

최소안: `GET /v1/templates?tag=<t>` 서버 필터 + openapi 에 `maxItems`/`maxLength`/`pattern` 선언.
완전안: `GET /v1/tags` → `[{tag, count}]`.

**지금 필요 없는 이유** — 태그를 쓰는 호출자가 사람 브라우저 하나뿐이고, 그 브라우저는 전체
목록을 이미 받으므로 클라이언트 집계로 충분하다. **필요해지는 시점**은 8번(MCP `list_templates`)
또는 5번(목록 페이지네이션)이다. 페이지를 나눠 받기 시작하면 "로드된 것에서 태그를 모은다" 가
그 자리에서 깨진다 — 첫 페이지에 없는 태그는 존재하지 않는 것이 되기 때문이다.

참고로 **프론트엔드는 이 제약의 부재를 이미 우회하고 있다.** 카탈로그의 '전체' 칩이 실재 태그와
충돌할 수 있어(`__all__` 도 유효한 태그다) `t:` 프리픽스 인코딩을 도입해야 했다
(`CatalogBrowser.tsx`, 회귀 테스트 `CatalogBrowser.test.tsx`). 1번(시더가 upsert 를 두 번
재구현)과 같은 신호다 — 우리 코드가 먼저 필요로 했다.

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
