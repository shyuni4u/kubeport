import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #71. `--muted` and `--secondary` were byte-identical to `--background` in
 * light mode, so every `bg-muted` surface on a page background was invisible:
 * tree and menu hovers gave no feedback, the release table header merged into
 * its rows, and the slider track disappeared (#43, worked around at the time
 * with a dedicated `--slider-track`).
 *
 * These assertions are about the token file rather than any one component,
 * because the bug was in the token file and reached ~30 call sites from there.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

function block(selector: string): string {
  // The token blocks are top-level and brace-free inside, so the first "}"
  // after the selector ends them.
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

/** Oklch lightness of a token, e.g. `--muted: oklch(0.94 0 0)` -> 0.94. */
function lightness(scope: string, token: string): number {
  const m = new RegExp(`${token}:\\s*oklch\\(([\\d.]+)`).exec(block(scope));
  if (!m) throw new Error(`${token} is not a plain oklch() value in ${scope}`);
  return Number(m[1]);
}

/**
 * WCAG relative-luminance contrast. For an achromatic colour Oklab's lightness
 * is the cube root of the relative luminance, which is what lets this compare
 * tokens straight out of the CSS without a colour library.
 */
function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi ** 3 + 0.05) / (lo ** 3 + 0.05);
}

describe("light-mode surface tokens", () => {
  const surfaces = ["--muted", "--secondary"] as const;

  it.each(surfaces)("%s is not the page background", (token) => {
    expect(lightness(":root", token)).not.toBe(lightness(":root", "--background"));
  });

  // 1.1:1 is roughly where a filled surface stops reading as "the same colour"
  // on a light page. It is far below the 3:1 that WCAG 1.4.11 asks of a real UI
  // component boundary — a muted fill is decoration, and the components that do
  // carry a boundary use --border or --slider-track instead.
  it.each(surfaces)("%s is far enough from the background to be seen", (token) => {
    expect(
      contrast(lightness(":root", token), lightness(":root", "--background")),
    ).toBeGreaterThan(1.1);
  });

  // --border sits between the two. A muted fill darker than its own border
  // would swallow the border on `border bg-muted` surfaces (MetaRow, the
  // dialog footers).
  it.each(surfaces)("%s stays lighter than --border", (token) => {
    expect(lightness(":root", token)).toBeGreaterThan(lightness(":root", "--border"));
  });
});

describe("dark-mode surface tokens", () => {
  // Dark mode was never broken; this keeps a later edit from levelling it the
  // way light mode was levelled.
  it.each(["--muted", "--secondary"])("%s is not the page background", (token) => {
    expect(lightness(".dark", token)).not.toBe(lightness(".dark", "--background"));
  });
});

describe("--slider-track", () => {
  // #43's dedicated token outlives the #71 fix: a slider track is a non-text UI
  // component under WCAG 1.4.11, and no muted-weight fill reaches 3:1 against a
  // light page. Written as an assertion so that "can we drop --slider-track
  // now?" has an answer in the repo instead of being re-argued.
  it("clears 3:1 against the card surface it sits on", () => {
    expect(
      contrast(lightness(":root", "--slider-track"), lightness(":root", "--card")),
    ).toBeGreaterThanOrEqual(3);
  });

  it("is darker than any muted-weight fill, so bg-muted cannot replace it", () => {
    expect(lightness(":root", "--slider-track")).toBeLessThan(lightness(":root", "--muted"));
  });
});
