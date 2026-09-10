# PR 리뷰어 시스템 설계 (`/pr-review`)

- 날짜: 2026-09-08
- 상태: 승인 대기 → 승인 후 `writing-plans` 로 구현 플랜 작성
- 관련: [self-improving-loop-design §4.2](2026-09-07-self-improving-loop-design.md) (주간 Routine·`agent-go` 자동 구현), `.claude/skills/role-review/`

## 1. 목표

PR 을 올릴 때마다 서로 다른 7개 페르소나가 변경 사항과 라이브 데모를 검토하고,
그 결과를 **PR 코멘트**(이 PR 이 유발한 문제)와 **GitHub Issue**(PR 과 무관한 기존 불만)로 남긴다.
정의는 리포에 커밋되어 Claude Code 가 설치된 어느 PC 에서든 동일하게 동작한다.

## 2. 확정된 결정

| 주제 | 결정 | 근거 |
|---|---|---|
| 실행 위치 | **로컬 Claude Code 스킬만** (GHA 없음) | 개발은 항상 Claude Code 설치 머신에서. API 키·예산·CI 스택 불필요, Chrome 확장 그대로 사용 |
| 강제 방법 | PreToolUse 훅이 `gh pr create` 차단 + 스킬이 리뷰→PR 생성→코멘트→이슈까지 수행 | 훅은 하네스가 실행하므로 잊어도 걸림 |
| 브라우저 대상 | 라이브 데모 `https://kubeport.enzo.kr` (`--base-url` 로 교체, 추후 staging) | 로컬 풀 스택은 PR 마다 띄우기 무거움. 라이브는 main 이므로 PR 회귀 검증은 한계 — 코멘트에 명시 |
| 구조 | `.claude/agents/*.md` 7개 + `.claude/skills/pr-review/` 오케스트레이터 | 페르소나 독립 수정·개별 호출·병렬 실행 |
| ai-reviewer 의미 | AI 에이전트가 kubeport 의 **소비자**인 상황 | 개발용 메타 리뷰 아님 |
| master-reviewer 깊이 | 기본은 문서 워크스루 + 정적 검증, `--deep` 시 kind 에 `helm install` | 설치 관련 파일이 diff 에 있으면 `--deep` 권고 |
| blocker 처리 | P0 있으면 PR 을 `--draft` 로 생성 | AI 오탐 가능성, 머지 판단은 사람 |
| 기존 불만 | GitHub Issue, 라벨 `reviewer` + `reviewer:<persona>`, fingerprint 로 dedupe | §4.2 `agent-go` 흐름과 호환 |

## 3. 파일 구조

```
.claude/
├── settings.json                  # 기존 + hooks.PreToolUse (리포 추적)
├── hooks/
│   └── require-pr-review.mjs      # `gh pr create` 차단 훅 (node, OS 무관)
├── agents/
│   ├── user-reviewer.md           # 신입/비전문가, demo-user 로 브라우저 조작
│   ├── admin-reviewer.md          # k8s 전문가·사내 클라우드 관리자, demo-admin 로 브라우저 조작
│   ├── design-reviewer.md         # UI/UX·시인성·사용자 친화성, 브라우저 + 스크린샷
│   ├── master-reviewer.md         # 설치자, 문서 워크스루 + helm lint/template (--deep: kind 설치)
│   ├── security-reviewer.md       # diff 정적 분석 + 데모 모드 외부인 방어 점검 (읽기 전용)
│   ├── ai-reviewer.md             # AI 에이전트가 소비자일 때 OpenAPI/에러/인증 경로 점검
│   └── reviewer-manager.md        # 결과 종합·판정·PR 코멘트·이슈 본문 작성
├── skills/
│   ├── pr-review/
│   │   ├── SKILL.md               # 오케스트레이터 (/pr-review)
│   │   └── references/
│   │       ├── finding-schema.md  # 리뷰어 공통 출력 규약 (§5)
│   │       └── demo-accounts.md   # 데모 로그인 절차·주의 (비밀번호는 화면 표기, 여기 없음)
│   └── role-review/               # 유지. user/admin 리뷰어가 페르소나·화면 맵 참조
└── reviews/                       # .gitignore. <branch>.md = 매니저 결과 + HEAD sha
```

`.claude/settings.json` 은 현재 `permissions.allow` 만 있고 리포에 추적되지 않는다(`?? .claude/settings.json`).
이 작업에서 추적 대상으로 올린다. `settings.local.json` 은 계속 무시.

## 4. 실행 흐름 — `/pr-review [--deep] [--dry-run] [--base-url URL]`

1. **준비**: 브랜치, `main` 대비 diff, 변경 파일 목록. 대상 URL 응답 확인(실패 시 브라우저 리뷰어 전부 "미검증" 처리하고 계속).
   `deploy/**`, `README.md`, `docs/dev-setup.md`, `docs/oci-prod-runbook.md` 가 diff 에 있고 `--deep` 이 없으면 권고 문구 출력.
2. **1차 병렬**: security / master / ai 를 `Agent` 로 동시에. 입력 = diff + 변경 파일 + 출력 규약 + 대상 URL.
3. **2차 순차**: user → admin → design. 같은 Chrome 프로파일이라 쿠키 충돌 → 반드시 순차. 각자 데모 로그인 → 페르소나 태스크 → 로그아웃.
   diff 를 함께 주어 "이 PR 이 건드린 화면"을 우선 방문하게 한다.
4. **매니저**: 6개 결과를 받아 §6 규칙으로 판정. 결과 = PR 코멘트 본문 + 이슈 목록 + 기각 목록.
5. **기록**: `.claude/reviews/<branch>.md` 에 매니저 결과와 `HEAD: <sha>` 저장.
6. **PR 생성**: `gh pr create` (CLAUDE.md 의 한국어 PR 규칙). P0 ≥ 1 이면 `--draft`. 이어 `gh pr comment` 로 매니저 코멘트 1개.
7. **이슈**: `scope=existing` 항목마다 `gh issue create`. 본문 끝 `<!-- reviewer-fp:<fingerprint> -->`.
   생성 전 `gh issue list --state open --label reviewer --search "reviewer-fp:<fp>"` 로 조회, 있으면 코멘트만 추가.
8. `--dry-run`: 5 까지 수행, 6·7 은 실행할 명령과 본문을 출력만.

브랜치 이름의 `/` 는 파일명에서 `__` 로 치환. 예상 소요 10–20분(브라우저 리뷰어가 대부분).

## 5. 리뷰어 출력 규약 (`references/finding-schema.md`)

리뷰어는 자유 서술 대신 아래 항목 목록만 반환한다.

| 필드 | 값 |
|---|---|
| `persona` | `user` / `admin` / `design` / `master` / `security` / `ai` |
| `scope` | `pr` (이 diff 가 유발·악화) / `existing` (PR 과 무관한 기존 문제) |
| `severity` | `P0` blocker / `P1` must-fix / `P2` nice-to-have |
| `title` | 한 줄, 한국어 |
| `evidence` | `file:line` 인용, 또는 브라우저 단계 + 스크린샷 경로 + 콘솔 에러 |
| `suggestion` | 구체 수정안: 코드 before→after / 문서 문장 / UI 요소와 변경 |
| `fingerprint` | `<persona>/<화면 또는 파일>/<문제 유형>` 소문자 kebab. 예 `user/deploy-form/raw-error` |

공통 가드레일:
- 근거 없는 발견 금지. 파일을 열지 않았거나 화면을 방문하지 않았으면 쓰지 않는다.
- 발견 0건이면 "확인한 범위"를 대신 보고한다.
- 페르소나 밖 영역은 언급하지 않는다(user-reviewer 가 보안을 말하지 않음).
- 사용자향 문자열 제안은 `messages/ko.json` + `messages/en.json` 양쪽.

### 페르소나 요약

| 페르소나 | 시선 | 방법 | 주로 보는 것 |
|---|---|---|---|
| user | 막 입사한 신입·비전문가 | demo-user 로 브라우저 | 카탈로그→배포→상태→로그→삭제. 용어 난이도, 에러 문장, 다음 행동 안내, 이중 제출 |
| admin | k8s 전문가, 사내 클라우드 관리자, "MCP 있으면 AI 로 하겠다" | demo-admin 로 브라우저 | 템플릿 작성→필드 노출→프리뷰→발행. k8s 용어 노출 충분성, RBAC 투명성, 파괴적 액션 confirm, 자동화 가능성 |
| design | UI/UX 디자이너 | 브라우저 + 스크린샷, ko/en 양쪽 | 시인성(대비·크기), 일관성, 빈/로딩/에러 상태, 반응형, 접근성 기본 |
| master | 처음 설치해 보는 운영자 | README→dev-setup→helm chart→deploy/oci 워크스루, `helm lint`/`helm template`/`docker compose config`; `--deep` 시 kind `helm install` | 빠진 단계, 전제 누락, 오타, values 설명, 시크릿 안내 |
| security | 사내 보안 검수자 | diff 정적 분석 + 라이브 읽기 전용 점검 | IDOR·인증 누락·입력 검증·시크릿 노출, 데모 모드에서 외부인의 admin 경로 접근, 데모 네임스페이스 격리, 쿠키/헤더 속성 |
| ai | AI 에이전트(소비자) 관점 | `backend/internal/api/routes.go` 라우트·핸들러·에러 응답 대조, `docs/` (kubeport 자체 API 의 OpenAPI 스펙은 현재 없음 — `openapi_proxy.go` 는 k8s 클러스터 스키마 프록시) | 자체 API 스펙 유무, 에러 응답의 기계 가독성, 토큰 획득 경로 문서, 목록/필터 API 충분성, MCP 부재 |
| manager | 리뷰 리드 | 6개 결과 종합 | §6 |

## 6. 매니저 판정 규칙

- `scope=pr` → PR 코멘트, `scope=existing` → 이슈. 리뷰어가 `pr` 로 냈어도 diff 에 해당 파일/화면이 없으면 `existing` 으로 강등.
- P0 는 근거에 **재현 단계 또는 file:line** 이 있을 때만 유지, 없으면 P1. blocker(draft PR) 판정은 P0 만.
- 같은 fingerprint 는 하나로 합치고 페르소나를 병기(다중 페르소나 = 신뢰도 근거).
- 페르소나 충돌(admin 은 용어 노출 / user 는 숨김)은 기각하지 않고 역할 분기·`KubeTermsToggle` 화해안 제시.
- 근거 부족 항목은 `기각` 목록에 사유와 함께 남긴다(코멘트 하단 접기).
- 리뷰어 실패(로그인 불가, 타임아웃)는 "미검증: <persona>, 사유" 로 표기하고 전체는 계속.

**PR 코멘트 형식** (한국어)
1. 요약표: 페르소나별 P0/P1/P2 건수, 브라우저 검증 여부, 대상 URL, 검토 HEAD sha
2. 항목 (severity 순): 제목 · 페르소나 · 근거 · 제안
3. "이슈로 넘긴 것 N건" 링크 목록
4. 접힌 기각 목록

**이슈 형식**: 제목 `[reviewer:<persona>] <title>`, 라벨 `reviewer`, `reviewer:<persona>`, 본문 = 근거·제안·규모(S/M/L)·발견 PR 링크·`<!-- reviewer-fp:... -->`.

## 7. 훅 — `.claude/hooks/require-pr-review.mjs`

`.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node .claude/hooks/require-pr-review.mjs" }] }
    ]
  }
}
```

동작:
1. stdin JSON 의 `tool_input.command` 에서 heredoc 본문과 따옴표 문자열을 제거한 뒤,
   `gh pr create` 가 **명령 위치**(줄머리 또는 `;` `&&` `|` `(` 뒤)에 있는지 본다. 없으면 exit 0.
   (PR 본문을 `cat <<EOF` 로 쓰면서 그 명령을 언급만 하는 경우를 오탐하지 않기 위해.)
2. `PR_REVIEW_SKIP=1` 이면 exit 0 — 환경변수든 명령 앞 인라인 접두어든 인정한다.
3. git 을 돌릴 디렉터리를 `PR_REVIEW_ROOT`(테스트 전용) → PreToolUse payload 의 `cwd`
   → `CLAUDE_PROJECT_DIR` → `process.cwd()` 순으로 정한다. payload `cwd` 를 env 보다 앞에
   두는 이유: CLAUDE.md 가 권장하는 워크트리 작업에서 `CLAUDE_PROJECT_DIR` 은 원본
   체크아웃(대개 `main`)을 가리켜 엉뚱한 브랜치·HEAD 를 검사하기 때문. 명령 안의 `cd` 는
   따라가지 않는다.
4. 그 디렉터리에서 `git rev-parse --abbrev-ref HEAD` / `HEAD` / `--show-toplevel`.
   git 리포가 아니면 exit 0 (fail-open).
5. `<toplevel>/.claude/reviews/<branch, "/"→"__">.md` 가 없거나 `HEAD:` 줄이 현재 sha 와
   다르면 stderr 에 "`/pr-review` 를 먼저 실행하세요 (리뷰 후 커밋이 추가되면 다시)" 출력 후 exit 2.
6. 그 외 exit 0.

우회 수단이 둘(`PR_REVIEW_SKIP`, `PR_REVIEW_ROOT`)인 것은 의도적이다 — 보안 통제가 아니라
실수 방지용 소프트 가드다. 또한 `settings.json` 은 훅 파일을 `CLAUDE_PROJECT_DIR` 기준으로
로드하므로, **실행되는 사본은 항상 원본 체크아웃의 작업트리**다(검사 대상 리포만 3번으로 정해진다).

node 를 쓰는 이유: Windows/WSL/macOS 모두에서 같은 스크립트. frontend 때문에 node 는 필수 툴.

## 8. 안전장치

- 브라우저 리뷰어는 **데모 계정만**, 데모 네임스페이스 안에서 UI 가 허용하는 동작만. **만든 것은 직접 지운다** — 리셋은 하루 한 번(KST 06:00)뿐이다. 실제 Google 계정 로그인 금지.
- security-reviewer 는 **읽기 전용**: 비인증 접근 가능 경로, 데모 계정으로 admin 경로 접근 시도, 응답 헤더·쿠키 속성 확인. 퍼징·부하·대량 자동 요청 금지(라이브 서비스).
- 모든 리뷰어 프롬프트에 `kubectl`/`helm`/`ssh` 로 프로드 조작 금지 명시. (§4.2 의 프로드 차단 훅은 별도 작업.)
- `--deep` 의 kind 설치는 로컬 Docker 에서만.
- 리뷰어가 사용하는 Chrome 확장 툴은 각 에이전트 frontmatter 의 `tools` 로 필요한 것만.

## 9. 테스트

- 훅: node 테스트 (`node --test`) — 파일 없음 → exit 2, sha 불일치 → exit 2, 일치 → exit 0, `gh pr create` 외 명령 → 개입 없음, `PR_REVIEW_SKIP=1` → 통과.
- 스킬·에이전트: `superpowers:writing-skills` 절차대로 검증. 이 작업의 PR 에 `--dry-run` 으로 먼저 돌려 출력 확인 → 실 실행으로 PR 코멘트·이슈가 실제로 달리는지 확인.
- dedupe: 같은 브랜치에서 두 번 실행 시 이슈 수가 늘지 않고 코멘트만 추가되는지.

## 10. 범위 밖

- GHA 실행, API 키 관리, CI 스택 (스펙 §4.2 그대로 두되 리뷰어 정의는 재사용 가능).
- 주간 Routine, `agent-go` 자동 구현.
- staging 환경 구축 (`--base-url` 로 대비만).
- 프로드 차단 훅(§4.2).
