import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "@/lib/color-contrast";

// The log pane is the one surface that does not use the design tokens. It is a
// terminal: a near-black ground with syntax-ish colours on it, chosen from
// Tailwind's palette directly, and #106's token work deliberately left it
// alone. That exemption is fine — what is not fine is that nothing then checks
// its contrast, and the timestamp sat at 4.24:1 for as long as it existed
// (#131). This is the check the tokens would otherwise have provided.

const SOURCE = join(__dirname, "LogsPanel.tsx");

// Tailwind's published palette, for the classes this pane uses. Hand-copied on
// purpose: the alternative is importing Tailwind's config to resolve a handful
// of constants, and a wrong value here fails loudly below rather than silently
// widening the bar. A class the pane starts using and this table does not know
// fails the "every colour is accounted for" test.
const PALETTE: Record<string, string> = {
  "slate-950": "#020617",
  "slate-400": "#94a3b8",
  "slate-300": "#cbd5e1",
  "slate-100": "#f1f5f9",
  "cyan-300": "#67e8f9",
  "red-300": "#fca5a5",
};

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** The pane's ground. Everything below is measured against it. */
const GROUND = "slate-950";

function paneSource(): string {
  return readFileSync(SOURCE, "utf8");
}

/** Every `text-<palette>` class the component names. */
function foregroundsUsed(): string[] {
  const src = paneSource()
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  const found = new Set<string>();
  for (const m of src.matchAll(/text-((?:slate|cyan|red|amber|green|blue)-\d{2,3})/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

describe("LogsPanel colours", () => {
  it("grounds the pane on the colour this file measures against", () => {
    expect(paneSource()).toContain(`bg-${GROUND}`);
  });

  it("knows every palette colour the pane uses", () => {
    const unknown = foregroundsUsed().filter((c) => !(c in PALETTE));
    expect(
      unknown,
      "add these to PALETTE with their hex from Tailwind, so their contrast is actually checked",
    ).toEqual([]);
  });

  // 12px is ordinary text under WCAG 1.4.3, not large text, so 4.5:1 is the
  // bar — 3:1 does not apply here however dim the intent was.
  it.each(Object.keys(PALETTE).filter((c) => c !== GROUND))(
    "clears 4.5:1 for %s on the pane",
    (colour) => {
      const ratio = contrastRatio(rgb(PALETTE[colour]), rgb(PALETTE[GROUND]));
      expect(ratio, `${colour} on ${GROUND}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  // The timestamp is meant to recede — that intent was right, and the fix was
  // never to make it as loud as the log text. Keeping both bounds means the
  // next person cannot satisfy the line above by simply brightening it to white.
  it("keeps the timestamp dimmer than the log text it sits beside", () => {
    const ground = rgb(PALETTE[GROUND]);
    const timestamp = contrastRatio(rgb(PALETTE["slate-400"]), ground);
    const body = contrastRatio(rgb(PALETTE["slate-100"]), ground);
    expect(timestamp).toBeLessThan(body);
  });
});
