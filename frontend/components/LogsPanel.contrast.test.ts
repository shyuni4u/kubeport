import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, oklchToSrgb } from "@/lib/color-contrast";

// The log pane is the one surface that does not use the design tokens. It is a
// terminal: a near-black ground with syntax-ish colours on it, taken from
// Tailwind's palette directly, and #106's token work left it alone on purpose.
// That exemption is fine — what is not fine is that nothing then checked its
// contrast, and the timestamp sat under the 4.5:1 bar for as long as it existed
// (#131). This is the check the tokens would otherwise have provided.

const COMPONENT = join(__dirname, "LogsPanel.tsx");

// The colours are read from the Tailwind that is actually installed, not from a
// table. The first version of this file hand-copied hex values, and they were
// Tailwind v3's — the repo is on v4, whose palette is defined in OKLCH and
// differs slightly — so the test measured colours no browser here renders.
// Nothing failed, because the conclusions happened to survive; that is exactly
// how a wrong constant goes unnoticed until the day it matters.
const THEME = join(__dirname, "..", "node_modules", "tailwindcss", "theme.css");

/** `--color-slate-400: oklch(70.4% 0.04 256.788);` → sRGB, via the repo's own conversion. */
function paletteColour(name: string): [number, number, number] {
  const css = readFileSync(THEME, "utf8");
  const m = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(css);
  if (!m) {
    throw new Error(
      `--color-${name} is not an oklch(L% C H) value in ${THEME} — Tailwind's theme format changed, and this test has to change with it`,
    );
  }
  // Tailwind writes L as a percentage; color-contrast.ts takes it as 0–1.
  return oklchToSrgb({ l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) });
}

/** The pane's ground. Everything below is measured against it. */
const GROUND = "slate-950";

/** Every `text-<hue>-<step>` class the component names, outside comments. */
function foregroundsUsed(): string[] {
  const src = readFileSync(COMPONENT, "utf8")
    .split("\n")
    .filter((l) => {
      const s = l.trimStart();
      return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("{/*");
    })
    .join("\n");
  const found = new Set<string>();
  // Any hue, not a list of the ones in use today. A narrower pattern let a
  // colour the pane had not used before walk past the check entirely.
  for (const m of src.matchAll(/text-([a-z]+-\d{2,3})\b/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

describe("LogsPanel colours", () => {
  it("grounds the pane on the colour this file measures against", () => {
    expect(readFileSync(COMPONENT, "utf8")).toContain(`bg-${GROUND}`);
  });

  it("finds the colours it measures", () => {
    // If the extraction silently matched nothing, every test below would pass.
    expect(foregroundsUsed().length).toBeGreaterThan(0);
  });

  // 12px is ordinary text under WCAG 1.4.3, not large text, so 4.5:1 is the
  // bar — 3:1 does not apply however dim the intent was. Every colour the pane
  // names is measured: adding one means it is checked, with no table to update.
  it("clears 4.5:1 for every text colour on the pane", () => {
    const ground = paletteColour(GROUND);
    const failing = foregroundsUsed()
      .map((c) => ({ c, ratio: contrastRatio(paletteColour(c), ground) }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ c, ratio }) => `${c} ${ratio.toFixed(2)}:1`);
    expect(failing, `on ${GROUND}`).toEqual([]);
  });

  // The timestamp is meant to recede — that intent was right, and the fix was
  // never to make it as loud as the log text. Holding both bounds means the
  // next person cannot satisfy the test above by brightening it to white.
  it("keeps the timestamp dimmer than the log text it sits beside", () => {
    const ground = paletteColour(GROUND);
    const timestamp = contrastRatio(paletteColour("slate-400"), ground);
    const body = contrastRatio(paletteColour("slate-100"), ground);
    expect(timestamp).toBeLessThan(body);
  });
});
