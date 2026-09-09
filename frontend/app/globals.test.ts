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

/**
 * Oklch lightness of a token, e.g. `--muted: oklch(0.93 0 0)` -> 0.93.
 *
 * Rejects anything with chroma, because `contrast()` below is only valid for
 * greys. Without the guard, pointing any of these assertions at a tinted token
 * like `--accent: oklch(0.95 0.03 275)` would not fail — it would quietly
 * assert a wrong number.
 */
function lightness(scope: string, token: string): number {
  const m = new RegExp(`${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)`).exec(block(scope));
  if (!m) throw new Error(`${token} is not a plain oklch() value in ${scope}`);
  if (Number(m[2]) !== 0) {
    throw new Error(
      `${token} has chroma ${m[2]}; the L = Y^(1/3) identity holds only for greys`,
    );
  }
  return Number(m[1]);
}

/**
 * WCAG relative-luminance contrast, for achromatic colours only — `lightness()`
 * enforces that.
 *
 * Oklab's linear-sRGB→LMS rows each sum to 1, so a grey has l = m = s = Y and
 * L = Y^(1/3); WCAG's luminance coefficients also sum to 1, so its Y is the
 * same number. That identity is what lets this compare tokens straight out of
 * the CSS without a colour library.
 */
function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi ** 3 + 0.05) / (lo ** 3 + 0.05);
}

/** Every surface a component can be drawn on, per theme. */
const SURFACES = ["--background", "--card"] as const;

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

describe("--muted-foreground", () => {
  // The label colour has to survive the surface moving under it. shadcn's
  // default sat at 4.34:1 on the old --background and would have dropped to
  // 3.85:1 once --muted darkened — on the very surfaces #71 makes solid.
  it.each([...SURFACES, "--muted"] as const)("clears 4.5:1 on %s", (surface) => {
    expect(
      contrast(lightness(":root", "--muted-foreground"), lightness(":root", surface)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("--slider-track", () => {
  // #43's dedicated token outlives the #71 fix: a slider track is a non-text UI
  // component under WCAG 1.4.11, and no muted-weight fill reaches 3:1 against a
  // light page. Written as an assertion so that "can we drop --slider-track
  // now?" has an answer in the repo instead of being re-argued.
  //
  // Every surface, both themes. Checking only --card is what let 0.66 stand at
  // 2.85:1 against --background — and the deploy form, the one screen with a
  // slider, draws it on --background.
  it.each(SURFACES)("clears 3:1 against %s in light mode", (surface) => {
    expect(
      contrast(lightness(":root", "--slider-track"), lightness(":root", surface)),
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(SURFACES)("clears 3:1 against %s in dark mode", (surface) => {
    expect(
      contrast(lightness(".dark", "--slider-track"), lightness(".dark", surface)),
    ).toBeGreaterThanOrEqual(3);
  });

  it("is darker than any muted-weight fill, so bg-muted cannot replace it", () => {
    expect(lightness(":root", "--slider-track")).toBeLessThan(lightness(":root", "--muted"));
  });
});
