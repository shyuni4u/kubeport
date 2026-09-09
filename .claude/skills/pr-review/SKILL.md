---
name: pr-review
description: >
  PR 을 올리기 전 7개 페르소나(user/admin/design/master/security/ai + manager)로 리뷰하고,
  결과를 기록한 뒤 PR 생성(P0 시 draft) → PR 코멘트 → 기존 문제는 GitHub Issue 로 등록한다.
  `gh pr create` 는 이 스킬의 기록 없이는 훅이 막는다. "PR 올려", "/pr-review", "리뷰하고 PR" 에 사용.
---

# /pr-review — 페르소나 리뷰 + PR 생성

인자: `--deep` (master 가 kind 에 실제 설치), `--dry-run` (PR·이슈 생성 대신 명령만 출력), `--base-url URL` (기본 `https://kubeport.enzo.kr`).

## 0. 사전 조건
- 현재 브랜치가 `main` 이 아니어야 한다. 커밋되지 않은 변경이 있으면 멈추고 사용자에게 커밋을 요청.
- `gh auth status` 성공.
- 훅(`require-pr-review.mjs`)은 실수 방지용 소프트 가드다 — 우회 가능하며 보안 통제가 아니다.
  판정 기준은 **세션 cwd(워크트리면 그 워크트리)** 하나뿐이다. 명령 안의 `cd` 는 따라가지 않으므로
  `cd <다른 리포> && gh pr create` 는 세션 리포의 기록으로 판정된다. 명시적 우회는
  `PR_REVIEW_SKIP=1`(긴급 시만), 검사 대상 변경은 `PR_REVIEW_ROOT`(테스트용).
  실행되는 훅 **파일**은 `CLAUDE_PROJECT_DIR`(원본 체크아웃)의 사본이다 — 워크트리에서 훅을 고쳐도
  원본 체크아웃이 그 커밋을 갖기 전까지는 옛 코드가 돈다.

## 1. 준비
```bash
BASE_URL=${BASE_URL:-https://kubeport.enzo.kr}   # --base-url 인자가 있으면 그 값
DEEP=false   # --deep 인자가 있으면 true
BRANCH=$(git rev-parse --abbrev-ref HEAD)
HEAD=$(git rev-parse HEAD)
git fetch -q origin main
CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
DIFF=$(git diff origin/main...HEAD)          # 4000줄 넘으면 파일별로 나눠 각 리뷰어엔 관련 파일만
SAFE_BRANCH=${BRANCH//\//__}
SHOT_DIR=.claude/reviews/shots/$SAFE_BRANCH
mkdir -p "$SHOT_DIR" && touch "$SHOT_DIR/.run-start"   # 스크린샷 회수 기준 시각 (§3)
curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/"   # 200 아니면 LIVE_OK=false, LIVE_OK=true/false 로 기록
```
`CHANGED_FILES` 에 `deploy/`, `README.md`, `docs/dev-setup.md`, `docs/oci-prod-runbook.md` 가 있고 `--deep` 이 없으면 한 줄 안내: "설치 관련 변경이 있습니다. `--deep` 으로 실제 설치 검증을 권합니다." (계속 진행.)

리뷰어에게 넘길 공통 프롬프트 골격:
```
BRANCH: <branch>
HEAD: <sha>
BASE_URL: <url>            (LIVE_OK=false 면 "UNREACHABLE")
DEEP: <true|false>
SHOT_DIR: .claude/reviews/shots/<SAFE_BRANCH>   (리뷰어는 직접 쓰지 않는다 — 툴이 돌려준 경로 또는 ss_ ID 를 finding-schema.md "스크린샷 증거" 규칙대로 적는다)
CHANGED_FILES:
<목록>
DIFF:
<diff>
결과는 .claude/skills/pr-review/references/finding-schema.md 형식의 YAML 블록 하나로만 답하라.
```

**에이전트 호출 규칙**: `Agent(subagent_type="<name>-reviewer")` 를 먼저 시도한다. "Agent type ... not found" 로 실패하면(세션 시작 후 추가된 에이전트) `.claude/agents/<name>.md` 를 읽어 frontmatter 이후 본문을 프롬프트 맨 앞에 "아래를 당신의 역할과 지시로 삼아라" 와 함께 붙이고 `subagent_type="general-purpose"` 로 호출한다. 브라우저 리뷰어의 경우 프롬프트에 Chrome MCP 툴 로드 안내(`ToolSearch` 로 `select:mcp__claude-in-chrome__tabs_context_mcp,...` 한 번에)를 추가한다.

## 2. 1차 — 코드 리뷰어 병렬
`Agent` 3개를 **한 메시지에서** 동시에 띄운다(호출 규칙 참조): `security-reviewer`, `master-reviewer`, `ai-reviewer`. 각 결과를 그대로 보관. 실패(에러/타임아웃)는 `FAILED: <사유>` 로 보관.

## 3. 2차 — 브라우저 리뷰어 순차
LIVE_OK=false 면 셋 다 `FAILED: 대상 URL 응답 없음` 으로 건너뛴다.
아니면 **반드시 한 번에 하나씩**: `user-reviewer` 완료 → `admin-reviewer` 완료 → `design-reviewer` 순으로 `Agent` 로 띄운다 (호출 규칙 참조). 같은 Chrome 프로파일이라 동시 로그인은 쿠키 충돌.
각 리뷰어는 demo-accounts.md 의 절차로 시작 시 이전 세션을 확인하고 종료 시 UI 메뉴로 로그아웃한다 (`/api/auth/logout` 은 POST 전용). 리뷰어 출력의 `verified` 에 로그아웃 확인이 없으면 다음 리뷰어 프롬프트 맨 앞에 "먼저 demo-accounts.md 0단계로 남은 세션을 정리하라" 를 붙인다.

**스크린샷 회수 (각 브라우저 리뷰어 종료 직후).** 확장은 `%TEMP%/claude-chrome-screenshots-*/screenshot-<ts>-N.jpg` 에 저장하거나(세션에 따라) 아예 저장하지 않고 `ss_xxxx` ID 만 돌려준다. 임시 디렉터리는 휘발되므로 리뷰어가 끝날 때마다 회수한다:
```bash
mkdir -p "$SHOT_DIR/<persona>"
find "$TEMP" -path '*claude-chrome-screenshots-*' -name 'screenshot-*.jpg' -newer "$SHOT_DIR/.run-start" -exec cp {} "$SHOT_DIR/<persona>/" \;
```
(`$SHOT_DIR/.run-start` 는 §1 에서 `touch` 해 둔 마커. Windows Git Bash 에선 `$TEMP` 가 이미 설정돼 있다.) 리뷰어 YAML 의 임시 경로는 기록 파일(§5)에 쓸 때 `SHOT_DIR/<persona>/<파일명>` 으로 치환한다. `ss_xxxx` ID 만 있는 항목은 치환하지 않고 그대로 둔다 — 파일이 없다는 뜻이며, finding-schema.md 규칙대로 설명 + DOM 값이 근거를 대신한다.

## 4. 매니저
`Agent(subagent_type="reviewer-manager")` 로 띄운다 (호출 규칙 참조). `BRANCH`, `HEAD`, `BASE_URL`, `DIFF_FILES`(이 필드에 `CHANGED_FILES` 값을 그대로 넣어 전달)와 6개 블록을 `--- <persona> ---` 구분자로 이어 전달. 응답을 `## PR_COMMENT` / `## ISSUES` / `## VERDICT` 로 자른다.
`## PR_COMMENT` 본문이 통째로 코드 펜스(세 개의 백틱)로 감싸져 있으면 바깥 펜스 한 쌍을 벗긴다. `## VERDICT` 도 마찬가지. `## ISSUES` 는 `yaml` 코드 펜스 안의 YAML 을 파싱한다.

## 5. 기록
`.claude/reviews/<SAFE_BRANCH>.md` 에 쓴다:
```
# pr-review — <BRANCH>
HEAD: <sha>
DATE: <ISO>
BASE_URL: <url>
DEEP: <bool>

<매니저 응답 전체>
```
(이 파일의 `HEAD:` 줄을 훅이 검사한다. 리뷰 후 커밋이 추가되면 다시 실행해야 한다.
워크트리에서 작업 중이면 기록은 **그 워크트리의** `.claude/reviews/` 에 쓴다 — 훅도 세션 cwd 의
git 루트를 기준으로 찾는다.)

## 6. PR 생성
`--dry-run` 이면 6·7·8 은 실행할 명령과 본문(PR 본문, 이슈 본문, PR 코멘트)을 코드 블록으로 출력만 하고 종료. `PR_URL` 은 `<dry-run>` 으로 표기.

- 제목: Conventional Commits 접두어 영문 + 한국어 요약 (CLAUDE.md "PR 작성" 규칙). 브랜치 커밋들을 보고 작성.
- 본문: `## 요약` / `## 테스트 계획` + 끝에
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- `VERDICT.draft` 가 true 면 `--draft`.
```bash
gh pr create --title "<title>" --body-file /tmp/pr-body.md [--draft]
PR_URL=$(gh pr view --json url -q .url)
```
훅이 막으면(기록 파일 sha 불일치) 5 로 돌아가 다시 기록.

## 7. 이슈
`## ISSUES` 각 항목:
```bash
gh label create reviewer --color 5319e7 --force >/dev/null 2>&1
gh label create "reviewer:<persona>" --color 5319e7 --force >/dev/null 2>&1
EXISTING=$(gh issue list --state open --label reviewer --search "reviewer-fp:<fingerprint>" --json number -q '.[0].number')
if [ -n "$EXISTING" ]; then
  gh issue comment "$EXISTING" --body "다시 발견됨: $PR_URL 리뷰 (@<HEAD 7자>)"
else
  gh issue create --title "[reviewer:<persona>] <title>" --label reviewer --label "reviewer:<persona>" \
    --body-file /tmp/issue-<n>.md     # body + "\n\n발견 PR: $PR_URL\n\n<!-- reviewer-fp:<fingerprint> -->"
fi
```
생성/코멘트된 이슈 URL 을 모아 `PR_COMMENT` 의 "이슈로 넘긴 기존 문제" 목록 항목을 URL 로 치환한다.

## 8. PR 코멘트
```bash
gh pr comment "$PR_URL" --body-file /tmp/pr-comment.md
```

## 9. 마무리 보고 (사용자에게)
PR URL, draft 여부, P0/P1/P2 합계, 이슈 N건(신규/코멘트), 미검증 페르소나와 사유. `SHOT_DIR` 경로와 회수된 파일 수 (0 이면 "확장이 이 세션에선 파일을 저장하지 않음 — evidence 는 ss_ ID + 설명" 이라고 명시).

## 실패 처리
- 리뷰어 하나가 실패해도 계속. 매니저가 "미검증" 으로 표기.
- 매니저 출력에 세 섹션이 없으면 한 번 재호출, 그래도 없으면 원문을 기록 파일에 저장하고 사용자에게 보고 후 중단 (PR 은 만들지 않음).
- `gh` 실패(인증·네트워크)는 명령과 에러를 그대로 보고.
