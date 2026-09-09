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

function runHook(command, { root, cwd, env = {} } = {}) {
  const payload = { tool_name: "Bash", tool_input: { command } };
  if (cwd) payload.cwd = cwd;
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, PR_REVIEW_SKIP: "", PR_REVIEW_ROOT: root ?? "", ...env },
    encoding: "utf8",
  });
}

function writeReview(dir, branchFile, sha) {
  mkdirSync(join(dir, ".claude/reviews"), { recursive: true });
  writeFileSync(join(dir, ".claude/reviews", branchFile), `# review\n\nHEAD: ${sha}\n`);
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

test("inline PR_REVIEW_SKIP=1 prefix in the command bypasses", () => {
  const { dir } = makeRepo();
  const r = runHook("git push && PR_REVIEW_SKIP=1 gh pr create --title x", { root: dir });
  assert.equal(r.status, 0);
});

test("mention inside a heredoc body or quoted string is not a gh pr create", () => {
  const { dir } = makeRepo();
  const heredoc = "cat > body.md <<'EOF'\nrun: gh pr create --title x\nEOF\necho done";
  assert.equal(runHook(heredoc, { root: dir }).status, 0);
  assert.equal(runHook('echo "next step: gh pr create"', { root: dir }).status, 0);
});

test("real gh pr create after a heredoc is still blocked", () => {
  const { dir } = makeRepo();
  const cmd = "cat > body.md <<'EOF'\nsummary\nEOF\ngh pr create --body-file body.md";
  assert.equal(runHook(cmd, { root: dir }).status, 2);
});

// CLAUDE.md tells you to run plan work in a git worktree. The session's cwd is
// then the worktree, while CLAUDE_PROJECT_DIR still points at the checkout
// Claude Code was launched in — so resolving against the env var alone reads
// the wrong branch and HEAD entirely.
test("resolves against the payload cwd, not CLAUDE_PROJECT_DIR", () => {
  const launched = makeRepo(); // still on feat/x, no review record
  const { dir: work, sha } = makeRepo();
  execSync("git branch -m feat/other", { cwd: work, stdio: "pipe" });
  writeReview(work, "feat__other.md", sha);

  const r = runHook("gh pr create --title x", {
    cwd: work,
    env: { CLAUDE_PROJECT_DIR: launched.dir },
  });
  assert.equal(r.status, 0, r.stderr);
});

test("a real worktree is checked against its own branch", () => {
  const { dir } = makeRepo();
  const wt = join(dir, "..", `wt-${Date.now()}`);
  execSync(`git worktree add -q -b feat/wt "${wt}"`, { cwd: dir, stdio: "pipe" });
  const wtSha = execSync("git rev-parse HEAD", { cwd: wt, stdio: "pipe" }).toString().trim();

  // The main checkout's record must not satisfy the worktree's branch.
  writeReview(dir, "feat__x.md", wtSha);
  const missing = runHook("gh pr create", { cwd: wt, env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /feat\/wt/);

  // The worktree's own record does. `--show-toplevel` resolves to the worktree,
  // so the file is expected next to the work, not in the main checkout.
  writeReview(wt, "feat__wt.md", wtSha);
  const ok = runHook("gh pr create", { cwd: wt, env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(ok.status, 0, ok.stderr);
});

test("PR_REVIEW_ROOT still overrides the payload cwd", () => {
  const { dir, sha } = makeRepo();
  writeReview(dir, "feat__x.md", sha);
  const elsewhere = makeRepo();
  const r = runHook("gh pr create", { root: dir, cwd: elsewhere.dir });
  assert.equal(r.status, 0, r.stderr);
});

test("malformed stdin passes through (never break unrelated tools)", () => {
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});
