import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { compositeOver, contrastRatio, oklchToSrgb, parseOklch } from "@/lib/color-contrast";

/**
 * #155. Dark mode was unreachable for as long as this repo existed, so nothing
 * checked what the classes that bypass the tokens look like there. When the
 * issue's author forced `.dark` on, the release list's chips and a dozen
 * notices and error lines kept their light-mode palette on a near-black page:
 * `text-red-700` measured 2.79:1 on a dark card, `text-amber-800` 2.53:1, and
 * the admin tables' `bg-white` put near-white text on white at 1.04:1.
 *
 * `globals.test.ts` holds the tokens. This file holds the other half — every
 * Tailwind palette class in the tree — the way `interaction-states.test.ts`
 * holds call sites: by scanning class strings, so the next component written
 * with `text-amber-700` fails the day it is written rather than the day
 * someone switches themes.
 */

type RGB = [number, number, number];
const ROOT = path.resolve(__dirname, "..");
const ROOTS = ["app", "components", "lib", "stores"] as const;

/**
 * LogsPanel is a terminal: its slate-950 ground is the same in both themes, so
 * its colours are measured against that ground by `LogsPanel.contrast.test.ts`
 * and are not theme-dependent at all.
 */
const EXEMPT = new Set(["components/LogsPanel.tsx"]);

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const file = path.relative(ROOT, full).replace(/\\/g, "/");
      if (EXEMPT.has(file)) continue;
      out.push({ file, text: readFileSync(full, "utf8") });
    }
  };
  for (const r of ROOTS) walk(path.join(ROOT, r));
  return out;
}

/** String literals that hold class names, outside comments. */
function classStrings(text: string): string[] {
  const code = text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join("\n");
  return [...code.matchAll(/"([^"\\\n]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s) => /(^|\s)([\w[\]=-]+:)*(text|bg|border)-/.test(s));
}

const FILES = sources();

const HUES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";

/**
 * A palette class with its variant prefix: `hover:bg-amber-100` → prefix
 * `hover:`, prop `bg`, colour `amber-100`.
 */
const PALETTE = new RegExp(
  `(?:^|\\s)((?:[\\w[\\]=-]+:)*)(text|bg|border)-((?:${HUES})-(\\d{2,3}))(?:/(\\d{1,3}))?(?![\\w-])`,
  "g",
);

/**
 * Fills and borders only need a dark twin when they are *surfaces* — the tints
 * at either end of the scale that invert meaning on a dark page. A mid-tone
 * signal fill (`bg-amber-500`, the unsaved-changes dot) reads the same on both
 * grounds. Text always needs one: it is read against the ground.
 */
function needsDarkTwin(prop: string, step: number): boolean {
  if (prop === "text") return true;
  return step <= 300 || step >= 700;
}

// ---- colours ----------------------------------------------------------------

const theme = readFileSync(path.join(ROOT, "node_modules", "tailwindcss", "theme.css"), "utf8");
function palette(name: string): RGB {
  const m = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(theme);
  if (!m) throw new Error(`--color-${name} not found as oklch(L% C H) in tailwindcss/theme.css`);
  return oklchToSrgb({ l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) });
}

const css = readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
function darkToken(name: string): RGB {
  const start = css.indexOf("@variant dark {");
  const block = css.slice(start, css.indexOf("}", start));
  const m = new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`).exec(block);
  if (!m) throw new Error(`${name} not in the dark token block`);
  return oklchToSrgb(parseOklch(m[1]));
}

/** The dark surfaces a class string with no fill of its own can be drawn on. */
const DARK_SURFACES = ["--background", "--card", "--muted"] as const;

// ---- tests ------------------------------------------------------------------

it("has sources and palette classes to scan", () => {
  expect(FILES.length).toBeGreaterThan(20);
  const all = FILES.flatMap((f) => classStrings(f.text)).join("\n");
  expect(all.match(PALETTE) ?? []).not.toHaveLength(0);
  expect(all).toMatch(/dark:text-/);
});

describe("hardcoded palette classes", () => {
  it("each carries a dark: twin for the same property and state", () => {
    const missing: string[] = [];
    for (const { file, text } of FILES) {
      for (const s of classStrings(text)) {
        for (const m of s.matchAll(PALETTE)) {
          const [, prefix, prop, colour, step] = m;
          if (prefix.split(":").includes("dark")) continue;
          if (!needsDarkTwin(prop, Number(step))) continue;
          if (!s.includes(`dark:${prefix}${prop}-`)) {
            missing.push(`${file}: \`${prefix}${prop}-${colour}\` has no \`dark:${prefix}${prop}-*\``);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  /**
   * `bg-white` is the light card by another name, and on a dark page it is a
   * white slab under light text. Use `bg-card`, which is white in light mode —
   * identical there — and the dark card here. The slider thumb is the one
   * exception: a white knob reads on both grounds and is outlined by --ring.
   */
  it("never paints a surface bg-white", () => {
    const bad: string[] = [];
    for (const { file, text } of FILES) {
      if (file === "components/ui/slider.tsx") continue;
      for (const s of classStrings(text)) {
        if (/(^|\s)([\w[\]=-]+:)*bg-white(?![\w-])/.test(s)) bad.push(file);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * The twin must also be readable. Measured against the fill the same string
   * paints in dark mode — composited over the dark page and card when it is
   * translucent — or, when it paints none, against every dark surface a bare
   * line of text lands on.
   */
  it("each dark: text colour clears 4.5:1 on the dark fill under it", () => {
    const failing: string[] = [];
    const bgRe = new RegExp(`(?:^|\\s)dark:bg-((?:${HUES})-\\d{2,3})(?:/(\\d{1,3}))?(?![\\w-])`);
    const fgRe = new RegExp(`(?:^|\\s)dark:text-((?:${HUES})-\\d{2,3})(?![\\w-/])`, "g");
    for (const { file, text } of FILES) {
      for (const s of classStrings(text)) {
        const bg = bgRe.exec(s);
        for (const m of s.matchAll(fgRe)) {
          const fg = palette(m[1]);
          const grounds: [string, RGB][] = bg
            ? bg[2]
              ? (["--background", "--card"] as const).map((surface) => [
                  `${bg[1]}/${bg[2]} over ${surface}`,
                  compositeOver(palette(bg[1]), Number(bg[2]) / 100, darkToken(surface)),
                ])
              : [[bg[1], palette(bg[1])]]
            : DARK_SURFACES.map((surface) => [surface, darkToken(surface)]);
          for (const [name, ground] of grounds) {
            const ratio = contrastRatio(fg, ground);
            if (ratio < 4.5) failing.push(`${file}: dark:text-${m[1]} on ${name} = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect([...new Set(failing)]).toEqual([]);
  });
});
