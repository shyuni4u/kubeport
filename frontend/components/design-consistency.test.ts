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

/** Tailwind's root font size, which its rem/em arbitrary values resolve against. */
const PX_PER: Record<string, number> = { px: 1, rem: 16, em: 16 };
const FLOOR_PX = 11;

describe("type scale", () => {
  // Spec §1.6 puts the floor at 11px. The editor had 9px status badges and
  // 10px meta labels — legible on the reviewer's display, not on a laptop at
  // arm's length, and the badges carry the fixed/exposed distinction that the
  // whole authoring model turns on.
  //
  // rem and em as well as px, because `text-[0.6rem]` is the same 9.6px by
  // another spelling and the repo already uses `text-[0.8rem]` elsewhere; and
  // inline `fontSize`, because MonacoPanel already sets one that way.
  it("has no font size below 11px", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const src = readFileSync(path.join(root, file), "utf8");
      for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g)) {
        if (Number(m[1]) * PX_PER[m[2]] < FLOOR_PX) offenders.push(`${file}: ${m[0]}`);
      }
      for (const m of src.matchAll(/fontSize:\s*["']?(\d+(?:\.\d+)?)(px)?["']?/g)) {
        if (Number(m[1]) < FLOOR_PX) offenders.push(`${file}: fontSize ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The rules above only bite if the patterns still match something. A typo in
  // a regex, or a Tailwind change to arbitrary-value syntax, would otherwise
  // turn the whole guard into a silent pass.
  it("is still matching the syntax it screens", () => {
    const all = sources()
      .map((f) => readFileSync(path.join(root, f), "utf8"))
      .join("\n");
    expect(all.match(/text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g) ?? []).not.toHaveLength(0);
    expect(all.match(/fontSize:\s*["']?(\d+(?:\.\d+)?)(px)?["']?/g) ?? []).not.toHaveLength(0);
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
