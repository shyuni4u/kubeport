import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compositeOver,
  contrastRatio,
  oklchToSrgb,
  parseOklch,
  type Oklch,
} from "@/lib/color-contrast";

/**
 * #71 started this file: `--muted` and `--secondary` were byte-identical to
 * `--background` in light mode, so every `bg-muted` surface on a page
 * background was invisible. The assertions live here rather than in any one
 * component because the bug was in the token file and reached ~30 call sites
 * from there.
 *
 * #110 #111 #112 #130 are the same shape one level up. Repairing `--muted`
 * moved the row hover from 1.064:1 to 1.124:1 — an invisible surface is still
 * invisible — because `--muted` is a *surface* token (table headers, the
 * resource panel, the editor meta row) and cannot be darkened to interaction
 * weight without making those surfaces heavy. So interaction state got tokens
 * of its own, and this file is where their floors are written down.
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

function token(scope: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*(oklch\\([^)]*\\))`).exec(block(scope));
  if (!m) throw new Error(`${name} is not an oklch() value in ${scope}`);
  return parseOklch(m[1]);
}

function rgb(scope: string, name: string): [number, number, number] {
  return oklchToSrgb(token(scope, name));
}

function ratio(scope: string, a: string, b: string): number {
  return contrastRatio(rgb(scope, a), rgb(scope, b));
}

/** Every surface a component can be drawn on, per theme. */
const SURFACES = ["--background", "--card"] as const;

const THEMES = [
  { name: "light", scope: ":root" },
  { name: "dark", scope: ".dark" },
] as const;

/**
 * WCAG 1.4.11 asks 3:1 of a non-text UI component. The bar here is 3.3 so the
 * tokens keep a margin: oklch is resolved to 8-bit channels and then through
 * the viewer's colour management, and a value that passes by 2% on paper is
 * relying on where those round. Asserting the margin is what stops a later
 * edit from spending it while still "passing".
 */
const SLIDER_TRACK_MIN_CONTRAST = 3.3;

/**
 * Interaction fills are held to 1.35:1 on the page surfaces.
 *
 * Not 3:1. A hover fill is not a component boundary — it is feedback on a
 * component that is already outlined — and no fill at 3:1 on a light page
 * reads as "hovered" rather than "selected"; it would swamp the row it is
 * meant to highlight. 1.35 is instead set from the failures: the reviewer
 * measured 1.064 and 1.124 as invisible and called 1.23 "only visible when
 * magnified", so the floor sits above all three by a margin no rounding can
 * eat. Selection does not lean on the fill alone — see
 * `interaction-states.test.ts`, which requires a second cue at every call site.
 */
const INTERACTION_MIN_CONTRAST = 1.35;

/**
 * Against `--muted` the bar drops to 1.25. A hovered item can sit on a muted
 * panel, but `--muted` is itself a near-background surface, so demanding the
 * full 1.35 there would force the hover darker than any hover should be. The
 * call sites that hover on muted are few and all carry a border of their own.
 */
const INTERACTION_MIN_CONTRAST_ON_MUTED = 1.25;

describe("light-mode surface tokens", () => {
  const surfaces = ["--muted", "--secondary"] as const;

  it.each(surfaces)("%s is not the page background", (name) => {
    expect(ratio(":root", name, "--background")).not.toBe(1);
  });

  // 1.1:1 is roughly where a filled surface stops reading as "the same colour"
  // on a light page. Deliberately far below the interaction floor above: a
  // muted fill is a surface, and the things that must be *noticed* — hover,
  // selection, a slider track — have their own tokens precisely so this one
  // does not have to carry them.
  it.each(surfaces)("%s is far enough from the background to be seen", (name) => {
    expect(ratio(":root", name, "--background")).toBeGreaterThan(1.1);
  });

  // --border sits between the two. A muted fill darker than its own border
  // would swallow the border on `border bg-muted` surfaces (MetaRow, the
  // dialog footers).
  it.each(surfaces)("%s stays lighter than --border", (name) => {
    expect(token(":root", name).l).toBeGreaterThan(token(":root", "--border").l);
  });
});

describe("dark-mode surface tokens", () => {
  // Dark mode was never broken; this keeps a later edit from levelling it the
  // way light mode was levelled.
  it.each(["--muted", "--secondary"])("%s is not the page background", (name) => {
    expect(ratio(".dark", name, "--background")).not.toBe(1);
  });
});

/**
 * Every surface text can be painted on, which is not the same list as
 * `SURFACES`: a hovered or selected row is a surface for the duration of the
 * hover, and the text on it does not change.
 *
 * That distinction is the one this PR's cross-review caught, twice. `--hover`
 * was chosen by measuring the fill against the page and nothing else, which
 * took a release row's `text-muted-foreground` cells from 4.90:1 to 3.67:1 and
 * its `text-primary` links to 3.20:1 — the fill got visible by making the text
 * fail. Adding a surface obliges you to re-check every foreground that can land
 * on it, so the list is written down once and every foreground is held to it.
 *
 * `--accent` is in the list although this PR did not touch it: it is a tinted
 * decorative surface (the catalog card's icon tile, the schema tree's exposed
 * badge) that text sits on, and leaving it out would repeat the omission in a
 * quieter place.
 */
const TEXT_SURFACES = [
  "--background",
  "--card",
  "--muted",
  "--hover",
  "--selected",
  "--accent",
] as const;

describe.each(["--foreground", "--muted-foreground", "--link"] as const)("%s", (fg) => {
  // The label colour has to survive the surface moving under it. shadcn's
  // default sat at 4.34:1 on the old --background and would have dropped to
  // 3.85:1 once --muted darkened — on the very surfaces #71 makes solid.
  //
  // --muted-foreground carries a second job since #112: a disabled control is
  // drawn as `bg-muted text-muted-foreground` instead of `opacity-50`, so this
  // pair is what a disabled button's label is made of. That is why --muted is
  // in the list and why the bar is the text bar rather than a decorative one.
  it.each(THEMES)("clears 4.5:1 on every text surface in $name mode", ({ scope }) => {
    for (const surface of TEXT_SURFACES) {
      expect(ratio(scope, fg, surface), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("--hover", () => {
  // #130. `hover:bg-muted/50` on the release-detail instance table measured
  // 1.064:1 — the reviewer's point was that no opacity and no surface fixes
  // it, because --muted is 13 steps of 255 from --background and everything
  // built on it tops out at 1.23:1.
  it.each(THEMES)("clears the interaction floor on every surface in $name mode", ({ scope }) => {
    for (const surface of SURFACES) {
      expect(ratio(scope, "--hover", surface), surface).toBeGreaterThanOrEqual(
        INTERACTION_MIN_CONTRAST,
      );
    }
    expect(ratio(scope, "--hover", "--muted")).toBeGreaterThanOrEqual(
      INTERACTION_MIN_CONTRAST_ON_MUTED,
    );
  });

  // The whole reason this token exists. Written as an assertion so "can we
  // just use bg-muted for hover?" has an answer in the repo.
  it.each(THEMES)("is not reachable from --muted in $name mode", ({ scope }) => {
    expect(ratio(scope, "--hover", "--muted")).toBeGreaterThan(1.15);
  });

  // Grey on purpose: hover is transient and must not be mistaken for the
  // persistent, tinted selection state it can appear next to.
  it.each(THEMES)("stays achromatic in $name mode", ({ scope }) => {
    expect(token(scope, "--hover").c).toBe(0);
  });
});

describe("--selected", () => {
  // #110. ToggleGroup, tabs and the catalog tag filter used `bg-muted` — or
  // nothing at all — as the only cue, measuring 1.00:1 against the page.
  it.each(THEMES)("clears the interaction floor on every surface in $name mode", ({ scope }) => {
    for (const surface of SURFACES) {
      expect(ratio(scope, "--selected", surface), surface).toBeGreaterThanOrEqual(
        INTERACTION_MIN_CONTRAST,
      );
    }
    expect(ratio(scope, "--selected", "--muted")).toBeGreaterThanOrEqual(
      INTERACTION_MIN_CONTRAST_ON_MUTED,
    );
  });

  // Selection and hover meet on the same element — you hover the row that is
  // already selected. Separating them by lightness alone would put them a few
  // percent apart; the tint is what keeps them distinct, so it is required
  // rather than left to taste.
  it.each(THEMES)("is tinted, unlike --hover, in $name mode", ({ scope }) => {
    expect(token(scope, "--selected").c).toBeGreaterThan(0);
  });

  it.each(THEMES)("carries a label colour that clears 4.5:1 on it in $name mode", ({ scope }) => {
    expect(ratio(scope, "--selected-foreground", "--selected")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("--destructive", () => {
  /**
   * #111 measured the Delete button's label at 3.97:1 and the same red on the
   * page at 4.38:1 — both under AA.
   *
   * The chip is the binding constraint. `Badge variant="destructive"` and
   * `Button variant="destructive"` put `text-destructive` on a red fill, so
   * the red is always read against a tint of itself; darkening the text
   * darkens the fill under it in step, which is why choosing this value by eye
   * against the page alone left it at 3.97:1.
   *
   * The fill is opaque (`--destructive-surface`) rather than
   * `bg-destructive/10`, so this ratio is a property of two tokens and not of
   * whatever the chip happens to be sitting on. That was the other half: a
   * translucent chip on a hovered release row composited over --hover and read
   * 3.32:1 with the same two tokens unchanged.
   */
  it.each(THEMES)("clears 4.5:1 on every surface and on its own chip in $name mode", ({ scope }) => {
    for (const surface of [...SURFACES, "--destructive-surface", "--destructive-surface-hover"]) {
      expect(ratio(scope, "--destructive", surface), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The guard that keeps the fill opaque. A translucent fill would pass the
  // assertion above — it is written against the token, not the rendered
  // pixel — while still inheriting its real contrast from the row underneath.
  it("has an opaque chip fill in both themes", () => {
    for (const scope of [":root", ".dark"]) {
      expect(() => token(scope, "--destructive-surface")).not.toThrow();
    }
  });

  // The old spelling, kept as a worked example of why it had to go: a 10% tint
  // of the same red over a hovered row is 3.32:1, under AA, with no token
  // change able to fix it.
  it("would still fail if the fill were left translucent", () => {
    const fg = rgb(":root", "--destructive");
    const overHover = compositeOver(fg, 0.1, rgb(":root", "--hover"));
    expect(contrastRatio(fg, overHover)).toBeLessThan(4.5);
  });
});

describe("--ring", () => {
  // #111 measured the focus ring at 2.13:1 — not because --ring is a weak
  // colour (it is 4.8:1 solid) but because every call site drew it through
  // `ring-ring/50`. A focus indicator is a non-text UI component under
  // WCAG 1.4.11, so 3:1 is the bar, and half of it is not.
  it.each(THEMES)("clears 3:1 on every surface in $name mode", ({ scope }) => {
    for (const surface of SURFACES) {
      expect(ratio(scope, "--ring", surface), surface).toBeGreaterThanOrEqual(3);
    }
  });

  // The token was never the problem; the alpha at the call sites was. Guard the
  // base layer here and the components in `interaction-states.test.ts`.
  //
  // Scoped to the `*` rule rather than the whole file, so the comment above it
  // can still name the value it replaced.
  it("is applied without alpha in the base layer", () => {
    const m = /\*\s*\{([^}]*)\}/.exec(css);
    expect(m, "no `* { … }` rule in globals.css").not.toBeNull();
    expect(m![1]).toContain("outline-ring");
    expect(m![1]).not.toMatch(/outline-ring\/\d/);
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
  it.each(THEMES)("clears 3:1 against every surface in $name mode", ({ scope }) => {
    for (const surface of SURFACES) {
      expect(ratio(scope, "--slider-track", surface), surface).toBeGreaterThanOrEqual(
        SLIDER_TRACK_MIN_CONTRAST,
      );
    }
  });

  it("is darker than any muted-weight fill, so bg-muted cannot replace it", () => {
    expect(token(":root", "--slider-track").l).toBeLessThan(token(":root", "--muted").l);
  });
});

describe("--switch-track", () => {
  // #39 put a Switch on the --muted preview card, where the unchecked track
  // (--input, 0.922) read 1.02:1 — users, who start with it off, saw no
  // control at all. Same WCAG 1.4.11 floor as --slider-track. Light mode only:
  // dark mode keeps shadcn's `dark:data-unchecked:bg-input/80` (#155).
  it("clears 3:1 against every light surface, --muted included", () => {
    // SURFACES is page and card; the switch that failed sat on a bg-muted card.
    for (const surface of [...SURFACES, "--muted"] as const) {
      expect(ratio(":root", "--switch-track", surface), surface).toBeGreaterThanOrEqual(
        SLIDER_TRACK_MIN_CONTRAST,
      );
    }
  });

  it("leaves the thumb (--background) readable on the track", () => {
    expect(ratio(":root", "--background", "--switch-track")).toBeGreaterThanOrEqual(
      SLIDER_TRACK_MIN_CONTRAST,
    );
  });
});

describe("token blocks", () => {
  // A token defined in one theme and forgotten in the other falls back to the
  // light value on a dark page. `--hover` and `--selected` are new, so this is
  // the moment the habit is cheapest to establish.
  it.each(["--hover", "--selected", "--selected-foreground", "--link", "--destructive-surface", "--destructive-surface-hover"])(
    "%s is defined in both themes",
    (name) => {
      expect(() => token(":root", name)).not.toThrow();
      expect(() => token(".dark", name)).not.toThrow();
    },
  );

  // Tailwind only emits `bg-hover` / `bg-selected` / `text-selected-foreground`
  // if the token is mapped in @theme. Without this the classes compile to
  // nothing and every fix in this PR silently reverts to a transparent fill.
  it.each(["--color-hover", "--color-selected", "--color-selected-foreground", "--color-link", "--color-destructive-surface"])(
    "%s is exposed to Tailwind via @theme",
    (name) => {
      expect(css).toContain(`${name}:`);
    },
  );
});
