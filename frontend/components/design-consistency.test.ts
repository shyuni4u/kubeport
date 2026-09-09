import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * #44. The template editor drifted from the design spec in ways that no single
 * component test would catch, because each one is a lone class on a lone
 * element. Both rules below are repo-wide for that reason: the spec is about
 * the whole surface, and the next violation will be in a file that does not
 * exist yet.
 */

const root = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

function sources(): string[] {
  return ["app", "components", "lib", "stores"].flatMap(walk);
}

describe("type scale", () => {
  // Spec §1.1 puts the floor at 11px. The editor had 9px status badges and
  // 10px meta labels — legible on the reviewer's display, not on a laptop at
  // arm's length, and the badges carry the fixed/exposed distinction that the
  // whole authoring model turns on.
  it("has no arbitrary font size below 11px", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const src = readFileSync(path.join(root, file), "utf8");
      for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) < 11) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Monaco", () => {
  // #44: YamlEditor imported @monaco-editor/react itself and left `theme`
  // unset, so it rendered light while MonacoPanel rendered vs-dark. Switching
  // ?mode=ui <-> ?mode=yaml inverted the code panel. One wrapper means one
  // theme, and the next option we set applies to both.
  it("is imported by exactly one wrapper", () => {
    const importers = sources().filter((f) =>
      /from\s+["']@monaco-editor\/react["']|import\(["']@monaco-editor\/react["']\)/.test(
        readFileSync(path.join(root, f), "utf8"),
      ),
    );
    expect(importers).toEqual(["components/MonacoPanel.tsx"]);
  });
});
