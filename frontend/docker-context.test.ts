import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The frontend image builds by running `pnpm build` over the Docker context,
 * which is this directory minus everything `.dockerignore` removes. So
 * `next build` inside the image type-checks a *smaller* file set than
 * `next build` in CI does, and an import that reaches into an excluded
 * directory succeeds here and fails there.
 *
 * That is not hypothetical: #67 was exactly this — `tests/` was excluded while
 * component tests imported `@/tests/intl-test-utils`, and the image build was
 * what caught it. The `.dockerignore` comment now records why `tests/` stays.
 *
 * Issue #116 stops running the image build for source-only PRs, which would
 * otherwise leave that class of break to surface on main. Editing
 * `.dockerignore` still triggers the image build (it is in the workflow's path
 * filter); what this covers is the other direction — a new import reaching into
 * a directory that is already excluded.
 */

const root = __dirname;

/** Directory prefixes `.dockerignore` removes from the build context. */
function ignoredDirs(): string[] {
  return readFileSync(path.join(root, ".dockerignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    // Only directories can hide a module. File patterns (.env*, *.log,
    // Dockerfile) are not importable.
    .filter((l) => l.endsWith("/"))
    .map((l) => l.replace(/\/$/, ""))
    // node_modules and .next are reinstalled/rebuilt inside the image, so
    // their absence from the context is not a missing module.
    .filter((d) => d !== "node_modules" && d !== ".next");
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
      walk(rel, acc);
    } else if (/\.tsx?$/.test(e.name)) {
      acc.push(rel);
    }
  }
  return acc;
}

const importRe = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

/** Where an import specifier lands, relative to this directory, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  }
  return null; // bare package specifier
}

describe("Docker build context", () => {
  const ignored = ignoredDirs();

  it("excludes at least one importable directory, or this guard is idle", () => {
    expect(ignored.length).toBeGreaterThan(0);
  });

  it("has no file importing a module the image build would not have", () => {
    const offenders: string[] = [];

    for (const file of walk("")) {
      // A file that is itself excluded cannot break the image build — the
      // image never sees it.
      if (ignored.some((d) => file === d || file.startsWith(`${d}/`))) continue;

      const src = readFileSync(path.join(root, file), "utf8");
      for (const m of src.matchAll(importRe)) {
        const target = resolveLocal(file, m[1]);
        if (!target) continue;
        const hit = ignored.find((d) => target === d || target.startsWith(`${d}/`));
        if (hit) {
          offenders.push(`${file} imports "${m[1]}" — .dockerignore excludes ${hit}/`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
