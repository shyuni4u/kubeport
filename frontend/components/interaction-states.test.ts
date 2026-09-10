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

const ROOTS = ["components", "app"] as const;

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx$/.test(entry) || /\.test\.tsx$/.test(entry)) continue;
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
    // `(?![\w-])` so `bg-secondary-foreground/10` is left alone: overlaying a
    // *foreground* at low alpha darkens whatever it lands on, which is the one
    // way to tint a chip whose own surface is unknown. `/50` still matches —
    // that is the case this is about.
    expect(hits(new RegExp(`${STATE}bg-(?:muted|accent|secondary|sidebar-accent)(?![\\w-])`))).toEqual([]);
  });

  it("never borrows a surface token through an opacity either", () => {
    // The trap #106 fell into: `bg-muted/30` -> `bg-muted` reads like a fix and
    // moves 1.064 to 1.124. Opacity cannot raise a fill above its own token.
    expect(hits(new RegExp(`${STATE}bg-(?:muted|accent|secondary|sidebar-accent)/`))).toEqual([]);
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
  it("never leave a hover to a rule the dark base outranks", () => {
    const broken: string[] = [];
    for (const { file, text } of FILES) {
      for (const m of text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        const classes = m[1];
        if (!/(?:^|\s)dark:bg-/.test(classes)) continue;
        if (!/(?:^|\s)hover:bg-/.test(classes)) continue;
        if (/(?:^|\s)dark:hover:bg-/.test(classes)) continue;
        broken.push(`${file}: a dark base fill with no dark hover`);
      }
    }
    expect(broken).toEqual([]);
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
      hits(/(aria-pressed|data-\[state=on\]|data-active|aria-selected):bg-(muted|accent|background)\b/),
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

  // The check above only sees the `variant:bg-selected` spelling. Selection is
  // just as often a ternary on a plain class string (SchemaTree, KindPicker),
  // which carries no prefix to match on — so the file as a whole has to show a
  // second cue too. Coarser, but it is the spelling half the call sites use.
  it("pairs the fill with a second cue in ternary call sites too", () => {
    const missing = FILES.filter(
      ({ text }) => text.includes("bg-selected") && !SECOND_CUE.test(text),
    ).map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});

describe("focus ring", () => {
  // #111 measured 2.13:1. --ring is 4.8:1 solid; every call site halved it.
  it("is never drawn at half alpha", () => {
    expect(hits(/(ring|outline)-ring\/\d/)).toEqual([]);
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
});
