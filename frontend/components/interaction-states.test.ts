import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The call-site half of the interaction-state fix (#110 #111 #112 #130).
 *
 * `globals.test.ts` proves the tokens are visible. That is necessary and not
 * sufficient: the same four issues were all *reachable* with correct tokens,
 * because twelve components reached for `--muted` — a surface — to express
 * hover, and three expressed selection with a fill and nothing else. #130's
 * own history is the argument for testing this layer: #106 raised the release
 * *list* table from `bg-muted/30` to `bg-muted` and the release *detail*
 * table, a different component, kept the old value and the old measurement.
 *
 * So these assertions are about class strings across the whole tree rather
 * than about any one component's render output. A new component that reaches
 * for the surface token fails here on the day it is written.
 */

/**
 * The same roots `design-consistency.test.ts` walks, deliberately.
 *
 * A narrower list would have been true today — `lib/` and `stores/` hold no
 * class strings — and false after one ordinary refactor: pulling `cva` variants
 * into a `.ts` file is a common move, and this guard would have stopped seeing
 * them without failing. That would quietly break the promise in the header
 * above.
 */
const ROOTS = ["app", "components", "lib", "stores"] as const;

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
      out.push({
        file: path.relative(path.resolve(__dirname, ".."), full).replace(/\\/g, "/"),
        text: readFileSync(full, "utf8"),
      });
    }
  };
  for (const root of ROOTS) walk(path.resolve(__dirname, "..", root));
  return out;
}

const FILES = sources();

/**
 * `file:line` for every line of `text` matching `re`, for a readable failure.
 *
 * Comment lines are skipped. Each of these classes is banned *and* named in the
 * comment above the line that replaced it — the old value is the reason the new
 * one is what it is — and a guard that cannot coexist with its own explanation
 * would just get the explanation deleted.
 */
function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const { file, text } of FILES) {
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (re.test(line)) found.push(`${file}:${i + 1}`);
    });
  }
  return found;
}

it("has sources to scan", () => {
  // Guards the walker itself: a broken path would make every assertion below
  // pass over an empty list.
  expect(FILES.length).toBeGreaterThan(20);
});

describe("hover and highlight", () => {
  /**
   * `--muted` and `--accent` are surfaces. Both were used as hover fills and
   * both measured invisible on the live site: `bg-muted/50` at 1.064:1 (#130)
   * and `bg-accent` at roughly 1.06:1 on the page background. `--hover` exists
   * so a hover does not have to borrow a surface's weight.
   *
   * `focus:` and `data-open:` are in the prefix list because a menu item's
   * highlight is the same state under a different name — the dropdown and
   * select items carried `focus:bg-accent`, which is what a *keyboard* user
   * navigates a menu by. A static `bg-accent` (the catalog card's icon tile,
   * the schema-tree badge) is untouched: that is a decorative surface, not a
   * state.
   */
  const STATE = "(?:hover|focus|data-open|data-popup-open|data-highlighted):";

  it("never borrows a surface token", () => {
    // Every fill token whose job is to *be* a surface. `card` and `popover` are
    // in the list although nothing hovers to them today: on this theme's grey
    // page a hover to white is 1.06:1, the same invisible step `bg-muted` gave.
    // The set was widened after a probe showed `hover:bg-card` walking past an
    // earlier, shorter version of this list.
    // `(?![\w-])` so `bg-secondary-foreground/10` is left alone: overlaying a
    // *foreground* at low alpha darkens whatever it lands on, which is the one
    // way to tint a chip whose own surface is unknown. `/50` still matches —
    // that is the case this is about.
    expect(hits(new RegExp(`${STATE}bg-(?:muted|accent|secondary|sidebar-accent|card|popover|background)(?![\\w-])`))).toEqual([]);
  });

  it("never borrows a surface token through an opacity either", () => {
    // The trap #106 fell into: `bg-muted/30` -> `bg-muted` reads like a fix and
    // moves 1.064 to 1.124. Opacity cannot raise a fill above its own token.
    expect(hits(new RegExp(`${STATE}bg-(?:muted|accent|secondary|sidebar-accent|card|popover|background)/`))).toEqual([]);
  });

  /**
   * The sidebar painted `--sidebar-accent` — about 1.11:1 on the white
   * sidebar — for "you are here" *and* for "your pointer is here". Neither
   * read as anything, and the two were the same colour besides, so the nav
   * could not say which page you were on. Same shape as #110, one screen over.
   */
  it("does not express the current nav item with a sidebar surface", () => {
    expect(hits(/\bbg-sidebar-accent\b/)).toEqual([]);
  });
});

/**
 * A dark-mode base fill silently outranks a theme-agnostic hover.
 *
 * `dark:bg-input/30` compiles to `.dark\:bg-input\/30:is(.dark *)` and
 * `hover:bg-hover` to `.hover\:bg-hover:hover` — the same specificity, with the
 * dark rule emitted later. So a variant that keeps a `dark:bg-*` base and
 * relies on a bare `hover:` loses its hover feedback in dark mode entirely,
 * with nothing in the class string to suggest it. shadcn ships the pair
 * (`dark:hover:bg-input/50`) for exactly this reason; dropping the dark half
 * while keeping the dark base is what broke the outline button.
 *
 * Confirmed against the emitted CSS in cross-review, not inferred.
 */
describe("dark-mode base fills", () => {
  /**
   * The unit checked is what actually renders together, which is not one string
   * literal: `cva` splits a component's classes across a base literal and one
   * literal per variant, and the browser sees base + variant. The dark fill and
   * the state that loses to it are routinely in different halves — the outline
   * button keeps `dark:bg-input/30` in its variant while `disabled:bg-muted`
   * lives in the base.
   *
   * So cva files are checked as base ∪ each variant, and everything else per
   * literal. Taking the whole file's union instead would pair a dark fill in
   * one variant with a hover in a different one and report a component that
   * cannot render both at once.
   */
  const STATES = ["hover", "focus", "disabled", "aria-pressed", "data-active"] as const;

  /** Literals that plausibly hold Tailwind classes, so import paths drop out. */
  const classish = (s: string) => /(^|\s)(bg-|text-|border-|dark:|hover:|focus|disabled:)/.test(s);

  function renderedCombinations(text: string): string[] {
    const literals = [...text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
      .map((m) => m[1])
      .filter(classish);
    if (!text.includes("cva(") || literals.length < 2) return literals;
    const [base, ...variants] = literals;
    return variants.map((v) => `${base} ${v}`);
  }

  it("never leave a state fill to a rule the dark base outranks", () => {
    const broken: string[] = [];
    for (const { file, text } of FILES) {
      for (const classes of renderedCombinations(text)) {
        if (!/(?:^|\s)dark:bg-/.test(classes)) continue;
        for (const state of STATES) {
          if (!new RegExp(`(?:^|\\s)${state}:bg-`).test(classes)) continue;
          if (new RegExp(`(?:^|\\s)dark:${state}:bg-`).test(classes)) continue;
          broken.push(`${file}: dark base fill outranks \`${state}:bg-*\``);
        }
      }
    }
    expect([...new Set(broken)]).toEqual([]);
  });
});

describe("selection", () => {
  const SELECTED_STATE = /((?:aria-[a-z]+|data-\[[^\]]+\]|data-[a-z-]+):)bg-selected\b/g;

  it("never expresses a selected state with a surface token", () => {
    // #110: ToggleGroup and tabs used `aria-pressed:bg-muted` /
    // `data-[state=on]:bg-muted` as the only cue, measured at 1.00:1.
    // `background` is in the list because that is what the active tab used: a
    // page-coloured chip on a muted rail, 1.13:1. A surface is a surface
    // whichever end of the scale it sits at.
    expect(
      hits(/(aria-pressed|data-\[state=on\]|data-active|aria-selected):bg-(muted|accent|background|card|popover|secondary|sidebar-accent)\b/),
    ).toEqual([]);
  });

  /**
   * A tint is the one cue a colour-blind viewer can lose, and `--selected` is a
   * tint. So wherever a state paints it, the same state must also change
   * something achromatic — a border, a ring, or the label colour.
   *
   * This is the assertion that keeps the fix honest rather than merely darker.
   */
  const SECOND_CUE = /(text-selected-foreground|border-|ring-|shadow-|underline|font-semibold)/;

  it("always pairs the fill with a second, non-colour cue", () => {
    const missing: string[] = [];
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(SELECTED_STATE)) {
        const prefix = m[1];
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(escaped + SECOND_CUE.source).test(text)) {
          missing.push(`${file}: \`${prefix}bg-selected\` has no second cue`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * The check above only sees the `variant:bg-selected` spelling. Selection is
   * just as often a ternary on a plain class string (SchemaTree, KindPicker),
   * which carries no prefix to match on.
   *
   * Scoped to the string literal holding `bg-selected`, not the file. A
   * file-wide search passes on any unrelated `border-` elsewhere in the
   * component — a single `<div className="border-b">` was enough to let a bare
   * `bg-selected` through, which is exactly the tint-alone state this is here
   * to forbid. Found by a probe during review.
   */
  it("pairs the fill with a second cue in ternary call sites too", () => {
    const missing = FILES.flatMap(({ file, text }) =>
      [...text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
        .filter((m) => /bg-selected\b/.test(m[1]) && !SECOND_CUE.test(m[1]))
        .map(() => `${file}: \`bg-selected\` alone in a class string`),
    );
    expect(missing).toEqual([]);
  });
});

describe("focus ring", () => {
  // #111 measured 2.13:1. --ring is 4.8:1 solid; every call site halved it.
  it("is never drawn at half alpha", () => {
    expect(hits(/(ring|outline)-ring\/\d/)).toEqual([]);
  });

  // The same trick under another colour: the destructive variants drew their
  // focus ring as `ring-destructive/20`, which composites to about the same
  // 2:1 the primary ring did. `aria-invalid:` rings are left alone — those
  // mark a field, they are not the focus indicator.
  it("is never drawn at half alpha in a variant's own colour either", () => {
    expect(hits(/focus-visible:(ring|border)-[a-z-]+\/\d/)).toEqual([]);
  });

  /**
   * Focus owns the `ring` property; selection may not touch it.
   *
   * The first version of the pressed toggle used `aria-pressed:ring-1
   * ring-primary/40` alongside `focus-visible:ring-[3px] ring-ring`. Both are
   * one pseudo-class deep, so which one paints is decided by the order Tailwind
   * happens to emit them in — and if the pressed rule wins, a keyboard user
   * focusing an already-selected toggle gets no focus indicator at all, since
   * the base sets `outline-none`.
   *
   * Splitting the properties makes the question moot instead of answering it:
   * selection is a border, focus is a ring, and no emit order can make one
   * erase the other. Caught in cross-review.
   */
  it("is not overwritten by a selected state reusing the ring property", () => {
    expect(hits(/(aria-pressed|data-\[state=on\]|data-active|aria-selected|aria-current):ring-/)).toEqual(
      [],
    );
  });
});

describe("text colour", () => {
  /**
   * `--primary` is a fill; `--link` is the same hue at text weight.
   *
   * One token cannot be both. --primary is chosen so white sits on it, which
   * caps how dark it can go, and at that weight it was 4.82:1 as text on the
   * page — passing with nothing to spare, and failing on every tinted surface
   * including the new --hover (3.20:1 for a release-name link on a hovered
   * row). Dark mode makes the conflict explicit: readable-as-text and
   * usable-as-fill pull the value in opposite directions.
   *
   * `text-primary-foreground` is untouched — that is the label *on* a primary
   * fill, which is the pairing --primary is designed for.
   */
  it("never uses the fill token as a text colour", () => {
    expect(hits(/text-primary(?!-foreground)(?![\w-])/)).toEqual([]);
  });
});

describe("destructive fills", () => {
  /**
   * A translucent chip inherits its contrast from whatever it lands on, which
   * is how the same StatusChip read 5.35:1 on a card and 3.32:1 on a hovered
   * row. The opaque surface token makes it a property of the palette instead.
   *
   * The pairing is what matters, not the fill alone: LoginErrorBanner draws
   * `bg-destructive/5` as a plain tinted panel and puts --foreground and
   * --muted-foreground on it, which is 7:1 and has nothing to do with this. It
   * is `text-destructive` on a tint *of itself* that has no floor.
   */
  it("do not put destructive text on a translucent tint of itself", () => {
    const bad: string[] = [];
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        if (/bg-destructive\/\d/.test(m[1]) && /text-destructive/.test(m[1])) {
          bad.push(`${file}: translucent destructive fill under destructive text`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("disabled state", () => {
  /**
   * #112. `opacity-50` fades the fill and the label together, so the label's
   * contrast against its own button is preserved-in-ratio only if both were
   * the same colour — which is never. The measured result was 1.50:1 on the
   * deploy button and 3.81:1 on the editor's disabled slug field.
   *
   * The replacement is `bg-muted text-muted-foreground`, a pair globals.test.ts
   * holds at 4.5:1. Scoped to the controls that carry a *label*: a faded
   * checkbox or switch loses no text, and changing those is a different
   * decision than this one.
   */
  const LABEL_BEARING = [
    "components/ui/button.tsx",
    "components/ui/toggle.tsx",
    "components/ui/tabs.tsx",
    "components/ui/input.tsx",
    "components/ui/select.tsx",
    // Not a ui/ primitive — a hand-rolled <button> in the kind picker. Listed
    // because the defect follows the label, not the directory.
    "components/KindPicker.tsx",
  ];

  it.each(LABEL_BEARING)("%s does not fade its label with opacity", (file) => {
    const src = FILES.find((f) => f.file === file);
    expect(src, `${file} not found — did it move?`).toBeDefined();
    expect(src!.text).not.toMatch(/(disabled|aria-disabled|data-disabled):opacity-\d/);
  });

  /**
   * The other half of the same state, asserted because this PR rewrote only the
   * first half.
   *
   * Colour makes a control *look* disabled; `pointer-events-none` makes it
   * *be* disabled. #112 replaced the colour across six components, and the
   * guard above only bans the old spelling — so a later edit could drop the
   * pointer-events half and the suite would stay green, with the control still
   * looking correct.
   *
   * The deploy form's RBAC gate is the case that matters: `rbacBlocked` reaches
   * a native `<Button disabled>`, so the browser suppresses submit. The backend
   * SSAR and k8s RBAC are still the deciding authority — this is a defence
   * layer, not the boundary — but losing a layer silently is the thing worth
   * preventing.
   *
   * Scoped to the ui/ primitives, which wrap base-ui: a select or menu item is
   * a `<div role="option">`, and there `pointer-events-none` is the only thing
   * stopping the click. KindPicker is left out because its disabled control is
   * a plain `<button disabled>` — the browser does not dispatch click on one at
   * all, so demanding the class there would be cargo cult rather than a guard.
   */
  it.each(LABEL_BEARING.filter((f) => f.startsWith("components/ui/")))(
    "%s still blocks interaction while disabled",
    (file) => {
      const src = FILES.find((f) => f.file === file);
      expect(src, `${file} not found — did it move?`).toBeDefined();
      expect(src!.text).toMatch(/(disabled|aria-disabled|data-disabled):pointer-events-none/);
    },
  );
});
