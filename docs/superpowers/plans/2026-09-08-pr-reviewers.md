# PR 리뷰어 시스템 (`/pr-review`) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/pr-review` 한 번으로 7개 페르소나 리뷰 → PR 생성(P0 시 draft) → PR 코멘트 → 기존 불만 GitHub Issue 등록까지 수행하고, 리뷰 없이 `gh pr create` 를 못 하게 훅으로 막는다.

**Architecture:** 페르소나는 `.claude/agents/*.md` 서브에이전트 7개, 오케스트레이션은 `.claude/skills/pr-review/SKILL.md`. 코드 리뷰어 3개는 병렬, 브라우저 리뷰어 3개는 순차(동일 Chrome 프로파일 쿠키 충돌), 매니저가 종합해 `.claude/reviews/<branch>.md` 에 기록하면 `gh pr create` 훅이 그 파일의 HEAD sha 를 검사한다. 전부 리포에 커밋되어 어느 PC 든 동일.

**Tech Stack:** Claude Code agents/skills/hooks (markdown + settings.json), Node 20+ (`node --test`, 훅), `gh` CLI, Chrome 확장 MCP (`mcp__claude-in-chrome__*`).

**Spec:** [docs/superpowers/specs/2026-09-08-pr-reviewers-design.md](../specs/2026-09-08-pr-reviewers-design.md)

## Global Constraints

- 실행 위치는 로컬 Claude Code 만. GHA·API 키 없음.
- 브라우저 대상 기본 URL `https://kubeport.enzo.kr`, `--base-url` 로 교체 가능.
- 브라우저 리뷰어는 데모 계정만 사용. 로그인 경로 `/api/auth/login?provider=demo&hint=<email>` (Dex 폼은 비어 열린다 — 이메일·비밀번호 모두 `/` 랜딩에 버튼별로 표기, #29). 로그아웃 `/api/auth/logout`. 계정: `demo-admin@demo.kubeport`, `demo-user@demo.kubeport`.
- 모든 리뷰어 프롬프트에 `kubectl`/`helm`/`ssh` 프로드 조작 금지, security 는 읽기 전용(퍼징·부하 금지).
- 리뷰어 출력은 `references/finding-schema.md` 규약만. 근거 없는 발견 금지.
- 사용자향 문자열은 한국어. PR 제목의 `type(scope):` 접두어는 영문, 본문 한국어 (CLAUDE.md).
- 커밋 author email `shyuniz@naver.com` 확인 후 커밋. 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 구현은 별도 워크트리 브랜치 `pr-reviewers` 에서. `.claude/reviews/` 는 gitignore.
- 훅 우회는 환경변수 `PR_REVIEW_SKIP=1` 만.

---

## 파일 구조

| 경로 | 책임 |
|---|---|
| `.claude/hooks/require-pr-review.mjs` | `gh pr create` 차단 판정. stdin JSON → exit 0/2 |
| `.claude/hooks/require-pr-review.test.mjs` | 위 스크립트의 `node --test` 테스트 (자식 프로세스로 실행) |
| `.claude/settings.json` | 기존 permissions + `hooks.PreToolUse` |
| `.gitignore` | `.claude/reviews/` 추가 |
| `.claude/skills/pr-review/references/finding-schema.md` | 리뷰어 공통 출력 규약 + 가드레일 (모든 에이전트가 읽음) |
| `.claude/skills/pr-review/references/demo-accounts.md` | 데모 로그인/로그아웃 절차, 금지 사항 (브라우저 에이전트가 읽음) |
| `.claude/agents/security-reviewer.md` `master-reviewer.md` `ai-reviewer.md` | 코드·문서 리뷰어 (병렬) |
| `.claude/agents/user-reviewer.md` `admin-reviewer.md` `design-reviewer.md` | 브라우저 리뷰어 (순차) |
| `.claude/agents/reviewer-manager.md` | 종합·판정·PR 코멘트·이슈 본문 생성 |
| `.claude/skills/pr-review/SKILL.md` | 오케스트레이터 |
| `CLAUDE.md` | "코드 리뷰" 절에 `/pr-review` 규칙 추가 |

에이전트 frontmatter 형식 (Claude Code 규약):
```yaml
---
name: <agent-name>
description: <언제 쓰는지 한 줄>
tools: Read, Grep, Glob, Bash        # 쉼표 구분. 생략하면 전부 상속
model: inherit
---
```

훅 stdin 형식 (Claude Code PreToolUse): `{"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"..."}`. exit 2 + stderr 가 차단 사유로 모델에 전달된다.

---

### Task 1: `gh pr create` 차단 훅 + 테스트 + settings.json

**Files:**
- Create: `.claude/hooks/require-pr-review.mjs`
- Create: `.claude/hooks/require-pr-review.test.mjs`
- Modify: `.claude/settings.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 리뷰 기록 파일 규약 — 경로 `.claude/reviews/<branch>.md` (브랜치의 `/` 는 `__` 로 치환), 파일 안 어딘가에 `HEAD: <40자 sha>` 한 줄. Task 6 의 스킬이 이 규약으로 파일을 쓴다.
- 환경변수 `PR_REVIEW_SKIP=1` → 항상 통과. 테스트용 `PR_REVIEW_ROOT=<dir>` → 그 디렉터리를 리포 루트로 간주 (git 명령도 `cwd` 로 그 안에서 실행).

- [ ] **Step 1: 워크트리 생성**

```bash
git worktree add .claude/worktrees/pr-reviewers -b pr-reviewers main
cd .claude/worktrees/pr-reviewers
git config user.email   # shyuniz@naver.com 이어야 함
```
이후 모든 작업은 이 워크트리에서.

- [ ] **Step 2: 실패하는 테스트 작성**

`.claude/hooks/require-pr-review.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "require-pr-review.mjs");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "prreview-"));
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
  run("git init -q -b feat/x");
  run('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
  return { dir, sha: run("git rev-parse HEAD") };
}

function runHook(command, { root, env = {} } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  return spawnSync("node", [HOOK], {
    input,
    env: { ...process.env, PR_REVIEW_SKIP: "", PR_REVIEW_ROOT: root ?? "", ...env },
    encoding: "utf8",
  });
}

test("non gh-pr-create commands pass through", () => {
  const { dir } = makeRepo();
  const r = runHook("git status", { root: dir });
  assert.equal(r.status, 0);
});

test("blocks when review file is missing", () => {
  const { dir } = makeRepo();
  const r = runHook("gh pr create --title x", { root: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\/pr-review/);
});

test("blocks when review HEAD differs from current HEAD", () => {
  const { dir } = makeRepo();
  mkdirSync(join(dir, ".claude/reviews"), { recursive: true });
  writeFileSync(join(dir, ".claude/reviews/feat__x.md"), "HEAD: 0000000000000000000000000000000000000000\n");
  const r = runHook("gh pr create", { root: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /커밋이 추가/);
});

test("passes when review HEAD matches", () => {
  const { dir, sha } = makeRepo();
  mkdirSync(join(dir, ".claude/reviews"), { recursive: true });
  writeFileSync(join(dir, ".claude/reviews/feat__x.md"), `# review\n\nHEAD: ${sha}\n`);
  const r = runHook("cd frontend && gh pr create --draft", { root: dir });
  assert.equal(r.status, 0);
});

test("PR_REVIEW_SKIP=1 bypasses", () => {
  const { dir } = makeRepo();
  const r = runHook("gh pr create", { root: dir, env: { PR_REVIEW_SKIP: "1" } });
  assert.equal(r.status, 0);
});

test("malformed stdin passes through (never break unrelated tools)", () => {
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `node --test .claude/hooks/`
Expected: 훅 파일이 없어 전부 FAIL (ENOENT 또는 status null).

- [ ] **Step 4: 훅 구현**

`.claude/hooks/require-pr-review.mjs`:
```js
#!/usr/bin/env node
// PreToolUse hook: block `gh pr create` unless .claude/reviews/<branch>.md
// records the current HEAD. Bypass: PR_REVIEW_SKIP=1. Test root: PR_REVIEW_ROOT.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function main() {
  if (process.env.PR_REVIEW_SKIP === "1") return 0;

  let command = "";
  try { command = JSON.parse(readStdin())?.tool_input?.command ?? ""; } catch { return 0; }
  // match `gh pr create` anywhere in a compound command (cd x && gh pr create ...)
  if (!/(^|[\s;&|])gh\s+pr\s+create\b/.test(command)) return 0;

  const cwd = process.env.PR_REVIEW_ROOT || process.cwd();
  const git = (args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

  let branch, head, root;
  try {
    branch = git("rev-parse --abbrev-ref HEAD");
    head = git("rev-parse HEAD");
    root = git("rev-parse --show-toplevel");
  } catch {
    return 0; // not a git repo — not our concern
  }

  const file = join(root, ".claude", "reviews", `${branch.replace(/\//g, "__")}.md`);
  if (!existsSync(file)) {
    process.stderr.write(
      `[require-pr-review] 이 브랜치(${branch})의 리뷰 기록이 없습니다. ` +
      `\`/pr-review\` 를 먼저 실행하세요. (기록 파일: ${file})\n`);
    return 2;
  }
  const m = readFileSync(file, "utf8").match(/^HEAD:\s*([0-9a-f]{40})\s*$/m);
  if (!m || m[1] !== head) {
    process.stderr.write(
      `[require-pr-review] 리뷰 이후 커밋이 추가되었습니다 (기록 ${m?.[1]?.slice(0, 7) ?? "없음"} ≠ 현재 ${head.slice(0, 7)}). ` +
      `\`/pr-review\` 를 다시 실행하세요.\n`);
    return 2;
  }
  return 0;
}

process.exit(main());
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `node --test .claude/hooks/`
Expected: 6 pass, 0 fail.

- [ ] **Step 6: settings.json 에 훅 등록, gitignore 갱신**

`.claude/settings.json` 전체를 아래로 교체 (기존 `permissions.allow` 유지):
```json
{
  "permissions": {
    "allow": [
      "Bash(ssh -i */oci_kuberport *)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/require-pr-review.mjs" }
        ]
      }
    ]
  }
}
```

`.gitignore` 의 `.claude/settings.local.json` 줄 아래에 추가:
```
# /pr-review 로컬 기록 (브랜치별 매니저 결과 + HEAD sha)
.claude/reviews/
```

- [ ] **Step 7: 훅이 실제 세션에서 동작하는지 수동 확인**

새 Claude Code 세션(또는 `/hooks` 로 재로드) 후 Bash 툴로 `gh pr create --help` 를 실행해 본다.
Expected: `[require-pr-review] 이 브랜치(pr-reviewers)의 리뷰 기록이 없습니다` 로 차단.
그다음 `PR_REVIEW_SKIP=1 gh pr create --help` 는 통과. (환경변수는 툴 명령 앞에 붙여도 훅 프로세스에 전달되지 않는다 — 훅은 하네스 환경을 쓴다. 세션 환경변수로 export 하거나, 이 확인은 테스트로 갈음해도 된다. 확인 결과를 커밋 메시지에 남긴다.)

- [ ] **Step 8: 커밋**

```bash
git add .claude/hooks .claude/settings.json .gitignore
git commit -m "feat(review): require-pr-review hook blocks gh pr create without a recorded review

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 공통 레퍼런스 — finding-schema.md, demo-accounts.md

**Files:**
- Create: `.claude/skills/pr-review/references/finding-schema.md`
- Create: `.claude/skills/pr-review/references/demo-accounts.md`

**Interfaces:**
- Produces: 리뷰어 반환 형식(아래 YAML 블록 규약). Task 3·4 의 모든 에이전트가 "결과는 `finding-schema.md` 형식으로만" 이라고 참조하고, Task 5 매니저가 이 형식을 파싱한다.

- [ ] **Step 1: finding-schema.md 작성**

```markdown
# 리뷰어 공통 출력 규약

리뷰어는 자유 서술 대신 **아래 YAML 블록 하나**만 최종 응답으로 반환한다.
매니저가 이 블록을 그대로 파싱하므로 형식을 지키지 않으면 결과가 버려진다.

```yaml
persona: user            # user | admin | design | master | security | ai
target: https://kubeport.enzo.kr   # 브라우저 리뷰어만. 코드 리뷰어는 생략
verified:                # 실제로 확인한 범위 (발견 0건이어도 반드시)
  - "카탈로그 → web-app 배포 폼 → 제출 → 릴리스 상세"
  - "frontend/components/DynamicForm.tsx 전체"
unverified:              # 하려 했으나 못 한 것 + 사유 (없으면 [])
  - "로그 탭: 릴리스가 Running 이 되기 전에 타임아웃"
findings:
  - scope: pr            # pr = 이 diff 가 유발·악화 | existing = PR 과 무관한 기존 문제
    severity: P1         # P0 blocker | P1 must-fix | P2 nice-to-have
    title: "배포 폼 제출 실패 시 영문 JSON 이 그대로 노출"
    fingerprint: user/deploy-form/raw-error   # <persona>/<화면 또는 파일 kebab>/<문제 유형 kebab>
    evidence: |
      frontend/components/DynamicForm.tsx:142 `setError(String(err))`
      브라우저: /catalog/web-app/deploy 에서 replicas=-1 제출 → 화면에 {"error":"..."} 표시. 스크린샷 .claude/reviews/shots/user-01.png
    suggestion: |
      setError(t("deploy.submitFailed")) 로 바꾸고
      messages/ko.json "deploy.submitFailed": "배포에 실패했어요. 잠시 후 다시 시도해 주세요."
      messages/en.json "deploy.submitFailed": "Deployment failed. Please try again."
```

## 필드 규칙

| 필드 | 규칙 |
|---|---|
| `scope` | diff 에 없는 파일/화면이면 반드시 `existing`. 확신 없으면 `existing` |
| `severity` | P0 는 **재현 단계 또는 file:line** 이 evidence 에 있을 때만. 데이터 유실·보안·배포 불가·핵심 플로우 중단이 P0 |
| `title` | 한국어 한 줄, 40자 이내 |
| `fingerprint` | 소문자 kebab, 슬래시 2개. 같은 문제는 실행마다 같은 값이 나오게 화면/파일 이름을 안정적으로 |
| `evidence` | 코드는 `path:line` + 인용. 브라우저는 URL + 밟은 단계 + 스크린샷 경로(`.claude/reviews/shots/<persona>-NN.png`) + 콘솔 에러 원문 |
| `suggestion` | 바로 적용 가능한 수준. 코드는 before→after, 문서는 문장, UI 는 요소와 변경 내용. 사용자향 문자열은 `messages/ko.json` + `messages/en.json` 양쪽 |

## 가드레일 (모든 페르소나 공통)

- **근거 없는 발견 금지.** 파일을 열지 않았거나 화면을 방문하지 않았으면 쓰지 않는다. 추측은 `unverified` 에.
- 발견 0건이면 `findings: []` 와 함께 `verified` 를 채운다.
- **페르소나 밖 영역은 언급하지 않는다.** user 가 보안을, security 가 UI 색상을 말하지 않는다.
- `kubectl`·`helm`·`ssh` 로 프로덕션(`oci-a1`, `kubeport.enzo.kr`)을 조작하지 않는다. 읽기도 하지 않는다.
- 한 페르소나당 findings 는 최대 10건. 넘치면 severity 높은 순으로 자르고 `unverified` 에 "P2 N건 생략" 을 적는다.
```

- [ ] **Step 2: demo-accounts.md 작성**

```markdown
# 데모 계정 — 브라우저 리뷰어용

대상 URL 은 오케스트레이터가 프롬프트로 준다 (기본 `https://kubeport.enzo.kr`). 아래 경로는 그 URL 기준 상대 경로.

## 로그인

1. `/` 로 이동. 랜딩에 "관리자로 체험" / "사용자로 체험" 버튼 2개와 데모 비밀번호가 표기되어 있다. **비밀번호는 화면에서 읽는다** (이 문서에 없음, 회전됨).
2. 버튼 대신 직접 이동해도 된다:
   - 사용자: `/api/auth/login?provider=demo&hint=demo-user@demo.kubeport`
   - 관리자: `/api/auth/login?provider=demo&hint=demo-admin@demo.kubeport`
3. Dex 로그인 폼이 뜬다. 이메일은 프리필. 비밀번호 입력 → Login.
4. 성공 시 `/catalog` 로 돌아오고 상단에 데모 배너가 보인다.

## 로그아웃 (리뷰 종료 시 반드시)

`/api/auth/logout` 으로 이동. 다음 리뷰어가 다른 계정으로 로그인해야 하므로 **로그아웃을 건너뛰면 다음 리뷰어가 잘못된 역할로 리뷰한다.**

## 허용 / 금지

- 허용: 데모 네임스페이스(`demo`) 안에서 UI 가 제공하는 모든 동작 — 템플릿 작성/발행, 배포, 삭제, 팀 페이지 열람. 6시간마다 리셋되므로 뒷정리 불필요.
- 금지: 실제 Google 계정 로그인. 데모 계정으로 UI 밖의 API 를 직접 호출해 대량 생성. 같은 동작 반복 5회 이상(부하).
- 시드 데이터: 템플릿 3개(`web-app`, `nightly-job`, `app-with-config`), 릴리스 2개(`web-app-demo` 정상, `nightly-job-demo` 는 존재하지 않는 이미지로 의도적 실패 — 실패 설명 배너가 정상). 근거: `backend/cmd/seed-demo/seed.go`.

## 브라우저 툴

Chrome 확장 MCP: `mcp__claude-in-chrome__tabs_context_mcp` 로 시작 → `tabs_create_mcp` 로 새 탭 → `navigate` / `computer` / `read_page` / `find` / `form_input` / `get_page_text` / `read_console_messages`. 스크린샷은 `computer` 의 screenshot 액션. 끝나면 `tabs_close_mcp`.
alert/confirm 다이얼로그를 띄우는 버튼(삭제 등)은 확장이 멈출 수 있으니, 누르기 전에 `javascript_tool` 로 `window.confirm = () => true` 를 심고 누른다.
```

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/pr-review/references
git commit -m "docs(review): finding schema and demo-account guide for pr-review agents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 코드·문서 리뷰어 에이전트 3개 (security / master / ai)

**Files:**
- Create: `.claude/agents/security-reviewer.md`
- Create: `.claude/agents/master-reviewer.md`
- Create: `.claude/agents/ai-reviewer.md`

**Interfaces:**
- Consumes: `references/finding-schema.md` (Task 2).
- Produces: 에이전트 이름 `security-reviewer`, `master-reviewer`, `ai-reviewer`. 오케스트레이터(Task 6)가 `Agent(subagent_type=<name>)` 로 호출하며 프롬프트에 `DIFF`, `CHANGED_FILES`, `BASE_URL`, `DEEP`(true/false) 를 넣어 준다. 각 에이전트는 finding-schema YAML 블록만 반환.

- [ ] **Step 1: security-reviewer.md**

```markdown
---
name: security-reviewer
description: 사내 보안 검수자 시선으로 PR diff 와 라이브 데모 모드를 읽기 전용 점검. /pr-review 가 호출.
tools: Read, Grep, Glob, Bash, WebFetch
model: inherit
---

당신은 이 제품(kubeport)을 사내에 도입하기 전 보안 검수를 맡은 담당자다. 관심사는 두 가지:
(1) 이 PR 이 새 취약점을 넣지 않는가, (2) 데모 모드가 켜진 채 외부에 열려 있을 때 외부인이 데모 경계를 넘을 수 없는가.

먼저 `.claude/skills/pr-review/references/finding-schema.md` 를 읽고 그 형식으로만 답한다.

## 입력
프롬프트에 `DIFF`, `CHANGED_FILES`, `BASE_URL` 이 온다.

## 1. diff 정적 분석 (반드시)
변경된 파일마다 실제로 열어 앞뒤 문맥을 본다. 체크:
- IDOR / 소유권 검사 누락: 릴리스·템플릿·팀 접근 시 `user_id`/팀 멤버십 확인이 빠졌는가 (`backend/internal/api/*.go`).
- 인증 미들웨어 우회: 새 라우트가 `routes.go` 에서 인증 그룹 밖에 등록됐는가.
- 입력 검증: 사용자 값이 k8s 매니페스트·SQL·셸에 그대로 들어가는가. YAML 렌더 경로(`internal/render`)의 인젝션.
- 시크릿: 로그·에러 메시지·프론트 응답에 토큰·비밀번호·CA 가 새는가. `.env`·values 파일에 실값이 커밋됐는가.
- BFF 경계: `frontend/app/api/**` 가 토큰을 브라우저에 노출하거나 허용하지 않은 헤더를 포워딩하는가.
- 데모 격리: `KBP_DEMO_EMAIL_DOMAIN` 사용자가 `demo` 네임스페이스 밖 클러스터/네임스페이스를 선택할 수 있는 경로가 생겼는가.
- Helm/deploy: 새 컨테이너가 privileged, hostNetwork, 과도한 RBAC 을 갖는가.

## 2. 라이브 읽기 전용 점검 (BASE_URL 이 응답할 때만)
`WebFetch` 또는 `curl -sI` 로 **각 경로 1회씩만**:
- 비인증으로 `/catalog`, `/releases`, `/admin/teams`, `/api/v1/templates` → 로그인으로 리다이렉트 또는 401 이어야 한다.
- 응답 헤더: `Set-Cookie` 에 `HttpOnly; Secure; SameSite`, `Strict-Transport-Security` 존재.
- `/api/auth/login?provider=demo&hint=<임의 외부 이메일>` 이 데모 도메인 밖 힌트를 받아도 권한 상승이 없는지는 **코드로** 판단한다 (실제 로그인 시도 금지).
퍼징·반복 요청·부하·인증 우회 시도 금지. 이건 라이브 서비스다.

## 금지
`kubectl`·`helm`·`ssh` 로 프로덕션 접근 금지. 데모 계정으로도 로그인하지 않는다 (브라우저 리뷰어 몫).

## 출력
finding-schema YAML 블록. `scope=pr` 은 diff 에 있는 파일에 근거할 때만. 라이브 점검에서 나온 것은 `existing`.
P0 기준: 인증 우회, 타 사용자 리소스 접근, 시크릿 노출, 데모 격리 탈출. 각각 재현 단계 또는 file:line 필수.
```

- [ ] **Step 2: master-reviewer.md**

```markdown
---
name: master-reviewer
description: 공개 리포를 처음 받아 설치해 보려는 운영자 시선으로 문서·차트·스크립트를 워크스루. /pr-review 가 호출.
tools: Read, Grep, Glob, Bash
model: inherit
---

당신은 GitHub 에서 kubeport 를 처음 발견해 자기 클러스터에 설치해 보려는 운영자다. 이 리포에 대한 사전 지식이 없다. 문서가 시키는 대로만 따라간다.

먼저 `.claude/skills/pr-review/references/finding-schema.md` 를 읽고 그 형식으로만 답한다.

## 입력
프롬프트에 `DIFF`, `CHANGED_FILES`, `DEEP`(true/false) 가 온다.

## 1. 문서 워크스루 (항상)
아래 순서로 **처음 읽는 사람처럼** 따라가며, 막히는 지점마다 finding 을 낸다:
1. `README.md` — 이게 뭔지, 어떻게 시작하는지 3분 안에 알 수 있는가. 설치 진입점 링크가 있는가.
2. `docs/dev-setup.md` — 툴 목록·버전·검증 커맨드가 실제 리포 상태와 맞는가 (`backend/go.mod` 의 go 버전, `frontend/package.json` 의 node/pnpm 요구와 대조).
3. `docs/local-e2e.md` — 로컬 기동 절차가 `deploy/docker/docker-compose.yml` 과 맞는가.
4. `deploy/helm/kubeport/values.yaml` + `README` — 필수 values 가 설명되어 있는가, 시크릿을 어디서 어떻게 주는지, 다른 Ingress class/StorageClass 에서 뭘 바꾸는지.
5. `deploy/oci/README.md` — OCI 특화 단계가 일반 k8s 사용자에게도 필요한 단계와 구분되는가.
6. `CLAUDE.md`·문서 곳곳의 `kuberport` 오타 (단, `~/.ssh/kuberport-oci/` 와 `oci_kuberport` 는 실제 파일명이라 오타가 아님 — 제외).

## 2. 정적 검증 (항상, 각 1회)
```
helm lint deploy/helm/kubeport
helm template kubeport deploy/helm/kubeport --set ingress.host=example.com > /dev/null
docker compose -f deploy/docker/docker-compose.yml config > /dev/null
cd backend && go build ./... && cd ..
```
실패하면 P0 (설치 불가). 툴이 없어 실행 못 하면 `unverified` 에 적는다.

## 3. 실제 설치 (DEEP=true 일 때만)
로컬 Docker 의 kind 클러스터에 설치한다. 프로덕션 클러스터 접근 금지.
```
kind create cluster --name pr-review
helm install kubeport deploy/helm/kubeport --namespace kubeport --create-namespace \
  -f deploy/helm/kubeport/ci/smoke-values.yaml --wait --timeout 5m
kubectl --context kind-pr-review -n kubeport get pods
kind delete cluster --name pr-review
```
`ci/smoke-values.yaml` 을 쓴다 — `--set` 나열은 차트를 따라가지 못하고 먼저 썩는다.
이전 판은 없는 키(`postgres.enabled`, 진짜는 `postgres.embedded`)를 넘겼고 helm 은 그걸
조용히 무시했으며, 필수값 누락으로 렌더 단계에서 죽었다 (#126). helm 은 CI 와 같은
3.20.2 를 쓴다.

문서에 없는 값을 넣어야 성공했다면 그것이 finding 이다 (문서에 없는 전제).

## 출력
finding-schema YAML. `scope=pr` 은 `CHANGED_FILES` 에 있는 문서/차트에 근거할 때만. 나머지는 `existing`.
suggestion 은 문서면 **넣을 문장 그대로**, 차트면 values 키와 값.
```

- [ ] **Step 3: ai-reviewer.md**

```markdown
---
name: ai-reviewer
description: AI 에이전트가 kubeport 의 소비자(사용자 대신 카탈로그 조회·배포·상태 확인)일 때 필요한 정보·API 가 갖춰졌는지 점검. /pr-review 가 호출.
tools: Read, Grep, Glob, Bash, WebFetch
model: inherit
---

당신은 "AI 비서에게 'web-app 하나 배포해 줘' 라고 시키면 kubeport 를 대신 조작해 주는" 에이전트를 만들려는 개발자다. 사람용 UI 가 아니라 **기계가 쓰기에** 이 시스템이 충분히 설명되고 예측 가능한지 본다.

먼저 `.claude/skills/pr-review/references/finding-schema.md` 를 읽고 그 형식으로만 답한다.

## 입력
프롬프트에 `DIFF`, `CHANGED_FILES`, `BASE_URL` 이 온다.

## 점검 항목 (각각 실제 파일을 열어 확인)
1. **API 스펙**: kubeport 자체 REST API(`backend/internal/api/routes.go` 의 `/v1/*`)에 OpenAPI 스펙이 있는가. 없으면 그 자체가 `existing` P1. (주의: `openapi_proxy.go` 는 k8s 클러스터 스키마 프록시이지 자체 스펙이 아니다.) 있다면 diff 의 라우트 변경이 스펙에 반영됐는가.
2. **에러 응답의 기계 가독성**: 핸들러가 4xx/5xx 에서 안정적인 JSON 형태(`{"error": {"code": ..., "message": ...}}` 같은)를 주는가, 아니면 문자열/HTML 이 섞이는가. `grep -rn 'c.JSON(http.Status' backend/internal/api` 로 형태 편차를 본다.
3. **인증 경로 문서**: 프로그램이 토큰을 얻어 `/v1/*` 를 호출하는 절차가 문서화됐는가 (`docs/` 검색: `Authorization`, `id_token`, `client_credentials`). OIDC 브라우저 플로우만 있으면 AI 는 로그인할 수 없다 → finding.
4. **목록·조회 충분성**: 템플릿 목록에서 ui-spec(필드 스키마)을 한 번에 얻을 수 있는가. 릴리스 상태를 폴링 없이(SSE) 받을 수 있는가. 필터·페이지네이션이 있는가.
5. **멱등성·확인**: 배포 요청에 dry-run/render 가 있는가 (`/render` 엔드포인트). 삭제에 확인 토큰이 필요한가.
6. **MCP**: MCP 서버가 있는가. 없으면 `existing` P2 로 "MCP 서버 부재" 한 건만 (반복 금지 — fingerprint `ai/platform/no-mcp-server`).
7. **라이브 확인** (BASE_URL 응답 시, 각 1회): `curl -s -o /dev/null -w '%{http_code} %{content_type}' BASE_URL/api/v1/templates` 비인증 응답이 JSON 401 인지 HTML 리다이렉트인지.

## 금지
프로덕션 클러스터 접근 금지. 데모 계정 로그인 금지. 라이브 요청은 항목 7 의 1회뿐.

## 출력
finding-schema YAML. diff 가 API 라우트/핸들러/문서를 건드리지 않았다면 대부분 `existing` 이 정상이다. 이미 잘 된 점은 `verified` 에 적는다.
```

- [ ] **Step 4: 에이전트가 로드되는지 확인**

새 세션 또는 `/agents` 로 목록에 `security-reviewer`, `master-reviewer`, `ai-reviewer` 가 보이는지 확인. 하나를 골라 `Agent(subagent_type="ai-reviewer", prompt="DIFF: (empty)\nCHANGED_FILES: (none)\nBASE_URL: https://kubeport.enzo.kr\n스모크: 항목 1·6 만 확인하고 finding-schema 형식으로 답하라.")` 로 호출해 YAML 블록이 돌아오는지 본다.
Expected: `persona: ai`, `findings:` 에 OpenAPI 부재·MCP 부재가 각각 `existing` 으로.

- [ ] **Step 5: 커밋**

```bash
git add .claude/agents/security-reviewer.md .claude/agents/master-reviewer.md .claude/agents/ai-reviewer.md
git commit -m "feat(review): security, master, ai reviewer agents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 브라우저 리뷰어 에이전트 3개 (user / admin / design)

**Files:**
- Create: `.claude/agents/user-reviewer.md`
- Create: `.claude/agents/admin-reviewer.md`
- Create: `.claude/agents/design-reviewer.md`

**Interfaces:**
- Consumes: `references/finding-schema.md`, `references/demo-accounts.md` (Task 2), `.claude/skills/role-review/SKILL.md` 의 페르소나·화면 소유 맵.
- Produces: 에이전트 이름 `user-reviewer`, `admin-reviewer`, `design-reviewer`. 프롬프트 입력 `DIFF`, `CHANGED_FILES`, `BASE_URL`, `SHOT_DIR`(스크린샷 저장 디렉터리). 반환은 finding-schema YAML. 종료 전 반드시 로그아웃.

Chrome 툴은 MCP 라 frontmatter `tools` 에 이름을 나열한다: `mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_close_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__read_console_messages, mcp__claude-in-chrome__javascript_tool`.

- [ ] **Step 1: user-reviewer.md**

```markdown
---
name: user-reviewer
description: 막 입사한 신입·비전문가가 demo-user 로 라이브 데모를 실제로 눌러보며 UX 를 검증. /pr-review 가 호출 (브라우저 리뷰어는 순차 실행).
tools: Read, Grep, Glob, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_close_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__read_console_messages, mcp__claude-in-chrome__javascript_tool
model: inherit
---

당신은 이번 주에 입사한 신입 개발자다. Kubernetes 를 써 본 적이 없다. 팀장이 "kubeport 에서 web-app 하나 띄워 봐" 라고 했다. 모르는 단어가 나오면 멈추고, 에러가 나면 무슨 뜻인지 모른다. 그 답답함을 그대로 기록하는 게 당신의 일이다.

시작 전에 읽는다: `.claude/skills/pr-review/references/finding-schema.md`, `.claude/skills/pr-review/references/demo-accounts.md`, `.claude/skills/role-review/SKILL.md` 의 "User" 페르소나와 "User 소유" 화면 맵.

## 입력
`DIFF`, `CHANGED_FILES`, `BASE_URL`, `SHOT_DIR`. `CHANGED_FILES` 에 User 소유 화면 파일이 있으면 그 화면을 **먼저·더 깊게** 본다.

## 태스크 (순서대로, 각 단계에서 막히면 finding + 스크린샷)
1. `BASE_URL` 접속 → "사용자로 체험" 으로 demo-user 로그인 (demo-accounts.md).
2. 카탈로그에서 `web-app` 찾기. 검색/필터가 도움이 되는가. 카드만 보고 "이게 뭘 만드는지" 알 수 있는가.
3. 배포 폼 열기. 각 필드 라벨을 읽고 **모르는 단어**를 적는다 (`(?)` 도움말이 있으면 열어 보고 그걸로 이해됐는지). 잘못된 값(빈 값, 음수, 너무 긴 이름)을 넣고 검증 메시지가 사람 말인지. 제출 버튼을 빠르게 두 번 누른다.
4. 정상 값으로 배포. 릴리스 상세로 이동했는가, 지금 무슨 일이 일어나는지 알 수 있는가. 30초 안에 상태가 바뀌는가.
5. 로그 탭. 처음 보는 사람이 "정상" 인지 알 수 있는가.
6. `nightly-job-demo` 릴리스(의도적 실패) 열기. 왜 실패했는지, 내가 뭘 해야 하는지 화면이 말해 주는가.
7. 내가 만든 릴리스 삭제. confirm 문구가 뭘 지우는지 말해 주는가. (`window.confirm = () => true` 심고 클릭.)
8. 언어 토글 en 으로 바꿔 3·6 화면만 다시 본다. 번역 안 된 문자열이 있는가.
9. `read_console_messages` 로 콘솔 에러 수집.
10. `/api/auth/logout` — **반드시**.

## 판단 기준 (role-review 의 User 루브릭)
용어가 평이한가 / 에러가 사용자 문장인가 / 다음 행동이 보이는가 / 빈·로딩 상태에 안내가 있는가 / 이중 제출이 막히는가.
보안·성능·코드 구조는 당신 관심사가 아니다 — 쓰지 않는다.

## 출력
finding-schema YAML. 라이브는 main 코드이므로 대부분 `scope=existing`. `CHANGED_FILES` 의 화면에서 본 문제만 `pr` 로 표시하되, 근거 코드 줄(`Grep` 으로 찾아)을 evidence 에 붙인다.
스크린샷은 `SHOT_DIR/user-NN.png`. 태스크마다 단계 수·잘못 클릭 수를 `verified` 에 한 줄로.
```

- [ ] **Step 2: admin-reviewer.md**

```markdown
---
name: admin-reviewer
description: k8s 전문가이자 사내 클라우드 관리자가 demo-admin 으로 라이브 데모의 템플릿 저작 흐름을 검증. /pr-review 가 호출 (브라우저 리뷰어는 순차 실행).
tools: Read, Grep, Glob, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_close_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__read_console_messages, mcp__claude-in-chrome__javascript_tool
model: inherit
---

당신은 사내 k8s 클러스터를 운영하는 플랫폼 엔지니어다. YAML 을 손으로 쓰는 게 빠르고, 도구가 k8s 를 숨기면 오히려 불안하다. 이 포털이 "내가 만든 템플릿을 개발자들이 안전하게 쓰게" 해 주는지, 그리고 "MCP 만 있으면 AI 한테 시킬 텐데" 라는 눈으로 자동화 가능성도 본다.

시작 전에 읽는다: `.claude/skills/pr-review/references/finding-schema.md`, `.claude/skills/pr-review/references/demo-accounts.md`, `.claude/skills/role-review/SKILL.md` 의 "Admin" 페르소나와 "Admin 소유" 화면 맵.

## 입력
`DIFF`, `CHANGED_FILES`, `BASE_URL`, `SHOT_DIR`. `CHANGED_FILES` 에 Admin 소유 화면이 있으면 먼저·깊게.

## 태스크
1. "관리자로 체험" 으로 demo-admin 로그인.
2. 템플릿 목록. 버전·draft·발행 상태가 한눈에 구분되는가.
3. 새 템플릿: Deployment + Service 짧은 YAML 을 붙여 넣는다 (아래). 에디터가 스키마 오류를 잡는가, 붙여넣기 후 SchemaTree 가 경로를 보여 주는가.
   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata: { name: review-app }
   spec:
     replicas: 1
     selector: { matchLabels: { app: review-app } }
     template:
       metadata: { labels: { app: review-app } }
       spec:
         containers:
           - name: app
             image: nginx:1.27
             ports: [{ containerPort: 80 }]
   ```
4. `spec.replicas` 와 `image` 를 사용자 필드로 노출. 라벨·타입·기본값·도움말을 설정하는 흐름이 몇 클릭인가. FieldInspector 가 enum/범위를 지원하는가.
5. 사용자 폼 프리뷰. 내가 노출한 것과 일치하는가.
6. 발행. draft→발행 구분과 "릴리스는 버전에 pin" 이 명확한가. 발행 후 편집 시 새 버전 강제가 되는가.
7. `/admin/teams`. 데모 제한 문구가 뜨는가 (기대 동작). RBAC 패널(배포 폼)에서 거부 사유가 k8s 용어로 표면화되는가.
8. 파괴적 액션(템플릿/버전 삭제) confirm. (`window.confirm = () => true` 후 클릭.)
9. 콘솔 에러 수집, `/api/auth/logout` — **반드시**.

## 판단 기준 (role-review 의 Admin 루브릭)
k8s 용어가 **충분히** 노출되는가 / 스키마↔폼 매핑이 보이는가 / 버전·draft 흐름이 명확한가 / 파괴적 액션이 보호되는가 / RBAC 판정이 투명한가 / 이 작업을 API·MCP 로 대체할 수 있는가(없으면 `existing` P2, fingerprint `admin/platform/no-automation-path`).
비전문가 친화성·색상·보안 코드 리뷰는 관심사가 아니다.

## 출력
finding-schema YAML. `scope=pr` 은 `CHANGED_FILES` 의 화면에서 본 것만, evidence 에 코드 줄 첨부. 스크린샷 `SHOT_DIR/admin-NN.png`.
```

- [ ] **Step 3: design-reviewer.md**

```markdown
---
name: design-reviewer
description: UI/UX 디자이너 시선으로 라이브 데모의 시인성·일관성·상태 디자인·접근성을 스크린샷 기반으로 검토. /pr-review 가 호출 (브라우저 리뷰어는 순차 실행).
tools: Read, Grep, Glob, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_close_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__resize_window, mcp__claude-in-chrome__javascript_tool
model: inherit
---

당신은 제품 디자이너다. 기능이 되는지가 아니라 **보이는지, 읽히는지, 일관된지, 상태가 설명되는지**를 본다. 근거는 항상 스크린샷이다.

시작 전에 읽는다: `.claude/skills/pr-review/references/finding-schema.md`, `.claude/skills/pr-review/references/demo-accounts.md`, `docs/superpowers/specs/2026-04-19-frontend-design-spec.md` (의도된 디자인).

## 입력
`DIFF`, `CHANGED_FILES`, `BASE_URL`, `SHOT_DIR`. `CHANGED_FILES` 에 `frontend/components/**` 또는 `frontend/app/**` 가 있으면 그 화면을 먼저.

## 화면 (demo-user 로 로그인해서 1–4, 로그아웃 후 demo-admin 으로 5–6)
1. 랜딩 `/` (비로그인) — YAML vs 폼 비교 쇼케이스 포함.
2. `/catalog`
3. `/catalog/web-app/deploy`
4. `/releases` 목록에서 `web-app-demo` 를 열어 개요·로그 탭, 그리고 `nightly-job-demo` 의 실패 배너.
5. `/templates` 목록.
6. 템플릿 버전 에디터 (`?mode=ui` 와 `?mode=yaml` 둘 다).

## 각 화면에서
- 뷰포트 2개: 1440×900, 390×844 (`resize_window`). 각각 스크린샷 → `SHOT_DIR/design-<화면>-<폭>.png`.
- 시인성: 본문 대비(회색 위 회색), 12px 미만 텍스트, 잘리는 라벨, 아이콘만 있는 버튼.
- 일관성: 버튼 위계(primary 하나뿐인가), 간격·모서리·색 토큰이 화면 간 같은가, 배지(`RoleBadge`/`StatusChip`) 의미 색이 일관되는가.
- 상태: 빈 상태·로딩·에러에 문구+다음 행동이 있는가. 스켈레톤/스피너 유무.
- 반응형: 390px 에서 가로 스크롤·겹침·사이드바 처리.
- 접근성 기본: `javascript_tool` 로 `document.querySelectorAll('img:not([alt]), button:not([aria-label]):empty, input:not([id])').length` 확인. 포커스 링이 보이는가 (Tab 키 3회 후 스크린샷).
- 언어: ko/en 토글 후 레이아웃이 깨지는가 (영문이 길어 줄바꿈).

## 판단 기준
사용자 친화성·시인성·일관성. 기능 버그·보안·용어 적절성은 다른 리뷰어 몫 — 쓰지 않는다. 디자인 스펙과 다른 점은 "스펙과 불일치" 로 명시.

## 출력
finding-schema YAML. 각 finding 의 evidence 에 스크린샷 경로 필수, 가능하면 컴포넌트 파일(`Grep` 으로 클래스명 검색)도. 마지막에 `/api/auth/logout`.
```

- [ ] **Step 4: 스모크 실행**

`Agent(subagent_type="user-reviewer", prompt="DIFF: (empty)\nCHANGED_FILES: (none)\nBASE_URL: https://kubeport.enzo.kr\nSHOT_DIR: .claude/reviews/shots\n스모크: 태스크 1·2·10 만 수행하고 finding-schema 형식으로 답하라.")`
Expected: 로그인 성공, 카탈로그 관찰 1건 이상 또는 `findings: []` + `verified`, 마지막에 로그아웃 수행 흔적. 실패하면 demo-accounts.md 의 절차를 실제 화면에 맞게 고친다 (버튼 문구·리다이렉트 경로).

- [ ] **Step 5: 커밋**

```bash
git add .claude/agents/user-reviewer.md .claude/agents/admin-reviewer.md .claude/agents/design-reviewer.md .claude/skills/pr-review/references/demo-accounts.md
git commit -m "feat(review): user, admin, design browser reviewer agents

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: reviewer-manager 에이전트

**Files:**
- Create: `.claude/agents/reviewer-manager.md`

**Interfaces:**
- Consumes: 6개 리뷰어의 finding-schema YAML 블록 (프롬프트로 이어 붙여 전달), `DIFF_FILES`(변경 파일 목록), `HEAD`, `BRANCH`, `BASE_URL`.
- Produces: 아래 3개 섹션을 가진 마크다운 하나. 오케스트레이터(Task 6)가 섹션 헤더로 잘라 쓴다.
  - `## PR_COMMENT` — `gh pr comment --body-file` 에 그대로 넣을 본문
  - `## ISSUES` — YAML 목록 `[{persona, title, fingerprint, labels, body}]`
  - `## VERDICT` — `blockers: <n>` 한 줄 + `draft: true|false`

- [ ] **Step 1: reviewer-manager.md**

```markdown
---
name: reviewer-manager
description: 6개 페르소나 리뷰 결과를 종합·검증·판정해 PR 코멘트 본문과 GitHub Issue 목록을 만든다. /pr-review 가 호출.
tools: Read, Grep, Glob
model: inherit
---

당신은 리뷰 리드다. 페르소나 리뷰어 6명(user, admin, design, master, security, ai)의 결과를 받아 **합당한 것만** 남기고, 이 PR 이 책임질 것과 백로그로 보낼 것을 가른다. 리뷰어는 AI 라 오탐이 있다 — 근거가 약하면 낮추거나 기각한다.

## 입력
프롬프트에 `BRANCH`, `HEAD`, `BASE_URL`, `DIFF_FILES`(줄바꿈 구분), 그리고 `--- <persona> ---` 구분자로 이어진 YAML 블록 6개 (실패한 리뷰어는 `FAILED: <사유>`).

## 판정 규칙 (순서대로 적용)
1. **형식 검증**: YAML 이 아니거나 `persona`/`findings` 가 없으면 그 리뷰어는 "미검증: <persona>, 출력 형식 오류" 로 처리.
2. **scope 강등**: `scope: pr` 인데 evidence 의 파일이 `DIFF_FILES` 에 없고, 화면 경로도 `DIFF_FILES` 의 컴포넌트와 무관하면 `existing` 으로. 확인은 evidence 의 `path:line` 을 `DIFF_FILES` 와 대조.
3. **P0 검증**: evidence 에 재현 단계(브라우저 URL+동작) 또는 `path:line` 이 없으면 P1 로. 남은 P0 는 `Read` 로 해당 줄을 열어 실제로 그 코드인지 확인, 아니면 기각.
4. **중복 병합**: 같은 `fingerprint`, 또는 제목·evidence 가 같은 문제를 가리키면 하나로. 페르소나를 병기하고 severity 는 최고값.
5. **충돌 화해**: admin 은 k8s 용어 노출을, user 는 숨김을 요구하는 식의 충돌은 둘 다 살리되 suggestion 을 "역할 분기 / `KubeTermsToggle`" 로 다시 쓴다.
6. **기각**: 근거 없음, 페르소나 밖 영역, 취향 수준(근거 스크린샷 없는 디자인 의견)은 기각 목록에 사유와 함께.
7. **blocker**: 규칙 3 을 통과한 P0 의 수. 1 이상이면 `draft: true`.

## 출력 (정확히 이 세 섹션, 이 순서)

## PR_COMMENT
(한국어. 아래 골격 그대로.)
```
## 🧑‍⚖️ 페르소나 리뷰 — `<BRANCH>` @ `<HEAD 7자>`

대상: <BASE_URL> (라이브 main 기준 — 이 PR 의 화면 변경은 브라우저에서 미검증, 코드로만 확인)

| 페르소나 | P0 | P1 | P2 | 검증 |
|---|---|---|---|---|
| user | 0 | 1 | 2 | 브라우저 ✅ |
| ... | | | | 미검증: <사유> |

### 🔴 P0 (blocker)
**<title>** — <persona(s)>
근거: ...
제안: ...

### 🟠 P1
...

### 🟡 P2
...

### 📋 이슈로 넘긴 기존 문제 <N>건
- [<persona>] <title> (fingerprint `<fp>`)   ← 오케스트레이터가 이슈 URL 로 치환

<details><summary>기각 <N>건</summary>
- <title> — 사유
</details>
```

## ISSUES
```yaml
- persona: ai
  title: "kubeport 자체 REST API 의 OpenAPI 스펙 없음"
  fingerprint: ai/platform/no-openapi-spec
  labels: [reviewer, "reviewer:ai"]
  size: M              # S | M | L
  body: |
    ## 발견
    <evidence>
    ## 제안
    <suggestion>
    ## 규모
    M
```
(`scope=existing` 항목만. `pr` 항목은 여기 넣지 않는다.)

## VERDICT
```
blockers: 0
draft: false
unverified: [design]
```
```

- [ ] **Step 2: 스모크**

가짜 입력으로 호출: 리뷰어 블록 2개(하나는 P0 인데 evidence 없음, 하나는 `scope: pr` 인데 파일이 `DIFF_FILES` 에 없음)를 만들어 `Agent(subagent_type="reviewer-manager", ...)`.
Expected: 첫 번째는 P1 로 강등, 두 번째는 `existing` → `## ISSUES` 에 등장, `## VERDICT` 에 `blockers: 0`, `draft: false`.

- [ ] **Step 3: 커밋**

```bash
git add .claude/agents/reviewer-manager.md
git commit -m "feat(review): reviewer-manager agent — verify, merge, and route findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `/pr-review` 오케스트레이터 스킬

**Files:**
- Create: `.claude/skills/pr-review/SKILL.md`

**Interfaces:**
- Consumes: 에이전트 7개(Task 3–5), 훅 규약(Task 1: `.claude/reviews/<branch>.md` 에 `HEAD: <sha>`).
- Produces: `/pr-review [--deep] [--dry-run] [--base-url URL]`.

- [ ] **Step 1: SKILL.md 작성**

```markdown
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

## 1. 준비
```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
HEAD=$(git rev-parse HEAD)
git fetch -q origin main
CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
DIFF=$(git diff origin/main...HEAD)          # 4000줄 넘으면 파일별로 나눠 각 리뷰어엔 관련 파일만
SAFE_BRANCH=${BRANCH//\//__}
mkdir -p .claude/reviews/shots
curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/"   # 200 아니면 LIVE_OK=false
```
`CHANGED_FILES` 에 `deploy/`, `README.md`, `docs/dev-setup.md`, `docs/oci-prod-runbook.md` 가 있고 `--deep` 이 없으면 한 줄 안내: "설치 관련 변경이 있습니다. `--deep` 으로 실제 설치 검증을 권합니다." (계속 진행.)

리뷰어에게 넘길 공통 프롬프트 골격:
```
BRANCH: <branch>
HEAD: <sha>
BASE_URL: <url>            (LIVE_OK=false 면 "UNREACHABLE")
DEEP: <true|false>
SHOT_DIR: .claude/reviews/shots
CHANGED_FILES:
<목록>
DIFF:
<diff>
결과는 .claude/skills/pr-review/references/finding-schema.md 형식의 YAML 블록 하나로만 답하라.
```

## 2. 1차 — 코드 리뷰어 병렬
`Agent` 3개를 **한 메시지에서** 동시에 띄운다: `security-reviewer`, `master-reviewer`, `ai-reviewer`. 각 결과를 그대로 보관. 실패(에러/타임아웃)는 `FAILED: <사유>` 로 보관.

## 3. 2차 — 브라우저 리뷰어 순차
LIVE_OK=false 면 셋 다 `FAILED: 대상 URL 응답 없음` 으로 건너뛴다.
아니면 **반드시 한 번에 하나씩**: `user-reviewer` 완료 → `admin-reviewer` 완료 → `design-reviewer`. 같은 Chrome 프로파일이라 동시 로그인은 쿠키 충돌.
각 리뷰어가 끝나면 `curl -s -o /dev/null "$BASE_URL/api/auth/logout"` 은 브라우저 쿠키에 영향이 없으므로, 리뷰어 출력에 로그아웃 흔적이 없으면 다음 리뷰어 프롬프트 맨 앞에 "먼저 /api/auth/logout 으로 이동해 로그아웃하라" 를 붙인다.

## 4. 매니저
`Agent(subagent_type="reviewer-manager")` 에 `BRANCH`, `HEAD`, `BASE_URL`, `DIFF_FILES`(=CHANGED_FILES) 와 6개 블록을 `--- <persona> ---` 구분자로 이어 전달. 응답을 `## PR_COMMENT` / `## ISSUES` / `## VERDICT` 로 자른다.

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
(이 파일의 `HEAD:` 줄을 훅이 검사한다. 리뷰 후 커밋이 추가되면 다시 실행해야 한다.)

## 6. PR 생성
`--dry-run` 이면 6·7 은 실행할 명령과 본문을 코드 블록으로 출력만 하고 종료.

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
PR URL, draft 여부, P0/P1/P2 합계, 이슈 N건(신규/코멘트), 미검증 페르소나와 사유. 스크린샷 디렉터리 경로.

## 실패 처리
- 리뷰어 하나가 실패해도 계속. 매니저가 "미검증" 으로 표기.
- 매니저 출력에 세 섹션이 없으면 한 번 재호출, 그래도 없으면 원문을 기록 파일에 저장하고 사용자에게 보고 후 중단 (PR 은 만들지 않음).
- `gh` 실패(인증·네트워크)는 명령과 에러를 그대로 보고.
```

- [ ] **Step 2: `--dry-run` 로 이 브랜치에서 실행**

`/pr-review --dry-run`
Expected: 6개 리뷰어 실행(브라우저 3개는 순차), 매니저 결과, `.claude/reviews/pr-reviewers.md` 생성, PR/이슈 명령이 코드 블록으로 출력. 소요 시간을 기록.
문제가 나오면 해당 에이전트/레퍼런스를 고치고 커밋한 뒤 다시 실행 (HEAD 가 바뀌므로 기록도 갱신됨).

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/pr-review/SKILL.md
git commit -m "feat(review): /pr-review orchestrator skill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CLAUDE.md 갱신 + 실 실행으로 PR 생성

**Files:**
- Modify: `CLAUDE.md` ("코드 리뷰" 절, "현재 상태" 블록)

- [ ] **Step 1: CLAUDE.md "코드 리뷰" 절 맨 위에 추가**

```markdown
- **PR 은 `/pr-review` 로 올린다**: 7개 페르소나(user/admin/design/master/security/ai + manager)가
  diff 와 라이브 데모를 리뷰 → `.claude/reviews/<branch>.md` 기록 → `gh pr create`(P0 시 draft) →
  PR 코멘트 → 기존 문제는 `reviewer:<persona>` 라벨 이슈. 기록 없이 `gh pr create` 는 훅이 막는다
  (우회 `PR_REVIEW_SKIP=1` 은 긴급 시만). 설치 관련 변경은 `--deep`. 스펙:
  [pr-reviewers-design](docs/superpowers/specs/2026-09-08-pr-reviewers-design.md).
```

"현재 상태" 블록에 한 줄:
```markdown
> - **PR 리뷰어 시스템 (2026-09-08)** — `/pr-review` 스킬 + `.claude/agents/*-reviewer.md` 7개 + `gh pr create` 훅. 리포에 커밋되어 모든 PC 공통. 브라우저 대상은 라이브 데모 (`--base-url` 로 staging 교체 예정).
```

- [ ] **Step 2: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs: /pr-review 규칙을 CLAUDE.md 코드 리뷰 절에 추가

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: 실 실행**

`git push -u origin pr-reviewers` 후 `/pr-review` (dry-run 아님).
Expected: PR 생성됨, 매니저 코멘트 1개, `reviewer` 라벨 이슈 N건. 훅 덕분에 `gh pr create` 가 기록 sha 와 일치할 때만 통과했음을 확인.

- [ ] **Step 4: dedupe 확인**

같은 브랜치에서 `/pr-review --dry-run` 을 한 번 더 돌려 `## ISSUES` 의 fingerprint 가 1차와 같은지 확인. 그다음 실제로 이슈 조회 명령만 실행:
```bash
gh issue list --state open --label reviewer --search "reviewer-fp:<1차 fingerprint 하나>" --json number
```
Expected: 기존 번호 1개가 나온다 (재실행 시 코멘트 경로로 갈 것).

- [ ] **Step 5: 결과 보고**

PR URL, 이슈 목록, 소요 시간, 첫 실행에서 고친 프롬프트 문제를 사용자에게 보고. `superpowers:finishing-a-development-branch` 로 마무리.
