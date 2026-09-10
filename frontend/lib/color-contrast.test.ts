import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  oklchToSrgb,
  parseOklch,
  relativeLuminance,
} from "./color-contrast";

/**
 * These assertions are the reason this module exists rather than a two-line
 * `L = Y^(1/3)` shortcut.
 *
 * The contrast failures in #110 #111 #112 #130 were all found by reading real
 * sRGB pixels out of a browser, and the fixes are argued in those numbers. A
 * test that computes contrast a *different* way than the browser paints would
 * assert the wrong thing quietly — the same failure mode as #129's two copies
 * of one grammar. So the conversion is pinned against colours that were
 * actually measured on the live site, and only then used to judge tokens.
 *
 * Tolerance is ±1 per channel: the browser resolves oklch through its own
 * colour management and the canvas readback rounds, so exact equality would be
 * asserting our rounding rather than our maths.
 */
function expectRgbNear(got: readonly [number, number, number], want: [number, number, number]) {
  got.forEach((v, i) => expect(Math.abs(v - want[i]), `channel ${i}: ${got} vs ${want}`).toBeLessThanOrEqual(1));
}

describe("oklchToSrgb — pinned to live measurements", () => {
  it("reproduces --destructive as measured on the Delete button (#111)", () => {
    expectRgbNear(oklchToSrgb(parseOklch("oklch(0.577 0.245 27.325)")), [231, 0, 11]);
  });

  it("reproduces --ring as measured with the alpha removed (#111)", () => {
    expectRgbNear(oklchToSrgb(parseOklch("oklch(0.55 0.22 275)")), [83, 88, 238]);
  });

  it("reproduces --background (#110 canvas readback)", () => {
    expectRgbNear(oklchToSrgb(parseOklch("oklch(0.97 0 0)")), [245, 245, 245]);
  });

  it("reproduces --muted after #106 separated it (#110 canvas readback)", () => {
    expectRgbNear(oklchToSrgb(parseOklch("oklch(0.93 0 0)")), [232, 232, 232]);
  });

  it("clamps out-of-gamut values into sRGB instead of returning NaN", () => {
    const [r, g, b] = oklchToSrgb({ l: 0.8, c: 0.4, h: 145 });
    for (const v of [r, g, b]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe("parseOklch", () => {
  it("reads lightness, chroma and hue", () => {
    expect(parseOklch("oklch(0.577 0.245 27.325)")).toEqual({ l: 0.577, c: 0.245, h: 27.325 });
  });

  it("defaults a missing hue to 0, which is what a grey has", () => {
    expect(parseOklch("oklch(0.93 0 0)")).toEqual({ l: 0.93, c: 0, h: 0 });
  });

  it("refuses anything that is not a plain oklch() triple", () => {
    // --border is `oklch(1 0 0 / 10%)`. Silently dropping the alpha would let a
    // caller compare a 10%-opacity border as if it were solid.
    expect(() => parseOklch("oklch(1 0 0 / 10%)")).toThrow(/alpha/i);
    expect(() => parseOklch("rgb(245,245,245)")).toThrow();
  });
});

describe("compositeOver", () => {
  it("reproduces the destructive chip fill measured on the live site (#111)", () => {
    // `bg-destructive/10` compiles to color-mix(... 10%, transparent), which is
    // --destructive at alpha 0.1; the browser then composites that over the
    // card. Measured: rgb(252,229,230) on the Delete button, rgb(253,230,231)
    // on the chip — a one-channel spread that is itself inside the tolerance.
    expectRgbNear(compositeOver([231, 0, 11], 0.1, [255, 255, 255]), [253, 230, 231]);
  });

  it("returns the backdrop at alpha 0 and the fill at alpha 1", () => {
    expect(compositeOver([231, 0, 11], 0, [255, 255, 255])).toEqual([255, 255, 255]);
    expect(compositeOver([231, 0, 11], 1, [255, 255, 255])).toEqual([231, 0, 11]);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrastRatio([83, 88, 238], [83, 88, 238])).toBeCloseTo(1, 5);
  });

  it("is symmetric — order of the pair does not change the ratio", () => {
    expect(contrastRatio([231, 0, 11], [245, 245, 245])).toBeCloseTo(
      contrastRatio([245, 245, 245], [231, 0, 11]),
      10,
    );
  });

  it("reproduces the failures the design reviewer measured (#111)", () => {
    // Delete button label: rgb(231,0,11) on the pink chip fill. Reported 3.97:1.
    expect(contrastRatio([231, 0, 11], [252, 229, 230])).toBeCloseTo(3.97, 1);
    // Same red on the page background. Reported 4.38:1.
    expect(contrastRatio([231, 0, 11], [245, 245, 245])).toBeCloseTo(4.38, 1);
    // The focus ring, composited from its 50% alpha onto white. Reported 2.13:1.
    expect(contrastRatio([169, 171, 246], [255, 255, 255])).toBeCloseTo(2.13, 1);
  });

  it("reproduces the disabled-button label failure (#112)", () => {
    // opacity-50 fades fill and label together: rgb(207,208,245) label on the
    // rgb(164,166,241) button. Reported 1.50:1.
    expect(contrastRatio([207, 208, 245], [164, 166, 241])).toBeCloseTo(1.5, 1);
  });

  it("reproduces the invisible row hover (#130)", () => {
    // `hover:bg-muted/50` over the page background. Reported 1.064:1.
    expect(contrastRatio([238, 238, 238], [245, 245, 245])).toBeCloseTo(1.064, 2);
  });
});

describe("relativeLuminance", () => {
  it("matches the WCAG endpoints", () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 10);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
});
