#!/usr/bin/env node
// PreToolUse hook: block `gh pr create` unless .claude/reviews/<branch>.md
// records the current HEAD. Bypass: PR_REVIEW_SKIP=1. Test root: PR_REVIEW_ROOT.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function stripLiterals(cmd) {
  // heredocs: <<EOF / <<'EOF' / <<-"EOF" ... up to a line that is exactly EOF
  let out = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, " ");
  // quoted strings (keep the shell structure around them)
  out = out.replace(/'[^']*'/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, " ");
  return out;
}

function main() {
  if (process.env.PR_REVIEW_SKIP === "1") return 0;

  let payload;
  try { payload = JSON.parse(readStdin()); } catch { return 0; }
  const command = payload?.tool_input?.command ?? "";
  // Only look at command positions: drop heredoc bodies and quoted strings so a
  // PR body written via `cat <<EOF` that merely mentions the command is ignored.
  const code = stripLiterals(command);
  // match `gh pr create` anywhere in a compound command (cd x && gh pr create ...)
  if (!/(^|[\s;&|(])gh\s+pr\s+create\b/.test(code)) return 0;
  // Inline bypass `PR_REVIEW_SKIP=1 gh pr create ...`: the hook runs in its own
  // process, so a prefix assignment never reaches process.env — read it here.
  if (/(^|[\s;&|(])PR_REVIEW_SKIP=1(\s|$)/.test(code)) return 0;

  // Resolve against the session's working directory before CLAUDE_PROJECT_DIR:
  // that env var points at the directory Claude Code was launched in, so in a
  // git worktree — which CLAUDE.md recommends for plan work — the hook would
  // read the branch and HEAD of the *original* checkout and demand a review
  // record for whatever branch happens to be checked out there.
  const cwd =
    process.env.PR_REVIEW_ROOT ||
    payload?.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
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
