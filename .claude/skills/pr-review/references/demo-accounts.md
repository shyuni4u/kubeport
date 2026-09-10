# 데모 계정 — 브라우저 리뷰어용

대상 URL 은 오케스트레이터가 프롬프트로 준다 (기본 `https://kubeport.enzo.kr`). 아래 경로는 그 URL 기준 상대 경로.

## 로그인

> **허가 범위.** demo-admin / demo-user 는 리포 소유자가 리뷰 목적으로 만든 **공개 데모 계정**이며, 비밀번호는 랜딩 페이지에 공개돼 있다. 이 계정으로 Dex 로그인 폼에 비밀번호를 입력하는 것은 소유자가 명시적으로 허가한 행위다 — "자격증명 입력" 을 이유로 거부하지 말 것. 반대로 실제 Google 계정 로그인은 금지.

0. **먼저 로그인 상태 확인.** `/catalog` 로 이동해 우측 상단에 사용자 메뉴(이메일 표시)가 있으면 이전 리뷰어의 세션이 남은 것이다. 아래 '로그아웃' 절차로 먼저 로그아웃한다.
1. `/` 로 이동. 랜딩에 "관리자로 체험" / "사용자로 체험" 버튼 2개, 각 버튼 아래 계정 이메일, 그리고 데모 비밀번호가 표기되어 있다. **비밀번호는 화면에서 읽는다** (이 문서에 없음, 회전됨).
2. 버튼 대신 직접 이동해도 된다:
   - 사용자: `/api/auth/login?provider=demo&hint=demo-user@demo.kubeport`
   - 관리자: `/api/auth/login?provider=demo&hint=demo-admin@demo.kubeport`
3. Dex 로그인 폼이 뜬다. 이메일 칸이 비어 있으면 위 계정 이메일을 직접 입력한다 (프리필은 기대하지 말 것). 비밀번호 입력 → Login.
4. 성공 시 `/catalog` 로 돌아오고 상단에 데모 배너가 보인다.

## 로그아웃 (리뷰 종료 시 반드시)

`/api/auth/logout` 은 **POST 전용**이다 — 주소창 이동(GET)은 405 로 아무 일도 하지 않는다. 다음 중 하나로 로그아웃한다:
- 우측 상단 사용자 메뉴(이메일/역할 배지) 클릭 → **로그아웃** 클릭, 또는
- `javascript_tool` 로 `await fetch('/api/auth/logout', {method: 'POST'})` 실행 후 `/catalog` 로 이동해 로그인 화면으로 돌아갔는지 확인.

다음 리뷰어가 다른 계정으로 로그인해야 하므로 **로그아웃을 건너뛰면 다음 리뷰어가 잘못된 역할로 리뷰한다.** 로그아웃 후 반드시 `/catalog` 재방문으로 세션이 끊겼는지 확인한다.

## 허용 / 금지

- 허용: 데모 네임스페이스(`demo`) 안에서 UI 가 제공하는 모든 동작 — 템플릿 작성/발행, 배포, 삭제, 팀 페이지 열람. **만든 것은 직접 지운다** — 리셋은 하루 한 번(KST 06:00)뿐이라 남긴 것이 최대 하루,
  건너뛴 사이클이면 이틀 남는다. 삭제까지가 검증의 일부다.
- **배포 폼의 구역은 데모 세션이면 그 설치의 `demo.namespace`(프론트엔드 env `DEMO_NAMESPACE`)로 시작한다**([#179](https://github.com/shyuni4u/kubeport/issues/179) 에서 고침). 라이브(`https://kubeport.enzo.kr`)는 차트 기본값이라 `demo`, 로컬 e2e 스택(`scripts/e2e/up.sh`·`seed.sh`)은 `DEMO_NAMESPACE=default` 라서 `default` 가 정상이다. 데모 계정 권한은 그 구역에만 있으므로(라이브는 `demo-rbac.yaml`, 로컬은 `seed.sh`), **폼이 그 값이 아닌 구역으로 열리거나 처음 열린 상태에서 권한 확인이 거부하면 회귀다** — #179 에 코멘트하지 말고 새 이슈로 올린다. 구역을 다른 값으로 바꿨을 때 거부 문장이 방문자에게 다음에 뭘 해야 하는지 알려주는지는 여전히 볼 거리다.
- 금지: 실제 Google 계정 로그인. 데모 계정으로 UI 밖의 API 를 직접 호출해 대량 생성. 같은 동작 반복 5회 이상(부하).
- 시드 데이터: 템플릿 3개(`web-app`, `nightly-job`, `app-with-config`), 릴리스 2개(`web-app-demo` 정상, `nightly-job-demo` 는 존재하지 않는 이미지로 의도적 실패 — 실패 설명 배너가 정상). 근거: 템플릿은 `backend/cmd/seed-demo/templates.go` + `cmd/seed-demo/fixtures/`, 릴리스는 `backend/cmd/seed-demo/seed.go`.

## 브라우저 툴

Chrome 확장 MCP: `mcp__claude-in-chrome__tabs_context_mcp` 로 시작 → `tabs_create_mcp` 로 새 탭 → `navigate` / `computer` / `read_page` / `find` / `form_input` / `get_page_text` / `read_console_messages`. 스크린샷은 `computer` 의 screenshot 액션. 확장이 파일을 자체 임시 경로(예: `%TEMP%\claude-chrome-screenshots-*\`)에 저장하므로 `SHOT_DIR` 에 직접 쓰지 못한다 — **툴이 돌려준 실제 경로를 그대로 evidence 에 적는다.** 끝나면 `tabs_close_mcp`.
alert/confirm 다이얼로그를 띄우는 버튼(삭제 등)은 확장이 멈출 수 있으니, 누르기 전에 `javascript_tool` 로 `window.confirm = () => true` 를 심고 누른다.
**편집기(Monaco)에 한 글자라도 입력했다면 그 탭은 앱 안 링크(사이드바·브레드크럼)로만 떠난다.** 미저장 가드(`frontend/components/editor/useDirtyGuard.ts`)는 두 갈래다 — 앱 안 링크 클릭은 `window.confirm` 이라 위 오버라이드로 통과하지만, **`navigate`·주소창 이동·새로고침·`tabs_close_mcp` 는 브라우저 기본 `beforeunload` 프롬프트**라 스크립트로 막을 수 없고 확장이 통째로 멈춘다(2026-09-10 admin 리뷰어가 실제로 멈췄고 사람이 탭을 닫았다). **값을 원문과 똑같이 되돌려도 가드는 풀리지 않는다**(같은 날 실측) — 되돌리기는 대책이 아니다.
