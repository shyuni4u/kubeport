/**
 * sRGB contrast maths for the design tokens.
 *
 * The token file is written in `oklch()`, but WCAG contrast is defined on sRGB
 * relative luminance, and the numbers every contrast issue is argued in
 * (#110 #111 #112 #130) were read as sRGB pixels out of a real browser. So the
 * only honest way to assert a token is to convert it the way the browser does
 * and then apply WCAG's formula — which is what this module is for.
 *
 * A shortcut exists for greys (Oklab's linear-sRGB→LMS rows each sum to 1, so a
 * grey has l = m = s = Y and L = Y^(1/3), and WCAG's coefficients also sum to 1
 * so its Y is the same number). It was used here before this module existed.
 * It is not enough any more: `--destructive`, `--ring`, `--primary` and the new
 * `--selected` all carry chroma, and the shortcut is silently wrong for them.
 *
 * `color-contrast.test.ts` pins the conversion against colours measured on the
 * live site, so a mistake in here fails there instead of quietly moving every
 * threshold that depends on it.
 *
 * **Test-only.** Its importers are `globals.test.ts` and this file's own test;
 * nothing in the product imports it, and nothing should. Contrast is not a
 * value to compute at runtime — it is baked into the tokens and held there by
 * tests. Wanting this module inside a component is the signal that the colour
 * in question should become a token instead. (It sits in `lib/` because that is
 * where the tests import from; it tree-shakes out of the bundle.)
 */

export type Oklch = { l: number; c: number; h: number };

/** `oklch(0.577 0.245 27.325)` → `{ l: 0.577, c: 0.245, h: 27.325 }`. */
export function parseOklch(css: string): Oklch {
  const value = css.trim();
  // Rejected rather than ignored: `--border` is `oklch(1 0 0 / 10%)`, and
  // treating that as solid white would compare a 10%-opacity hairline as if it
  // painted. A caller that means to composite must say so via compositeOver().
  if (value.includes("/")) {
    throw new Error(`${css} carries an alpha; composite it with compositeOver() before measuring`);
  }
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)(?:\s+([\d.]+))?\s*\)$/.exec(value);
  if (!m) throw new Error(`not a plain oklch() triple: ${css}`);
  return { l: Number(m[1]), c: Number(m[2]), h: m[3] === undefined ? 0 : Number(m[3]) };
}

function gammaEncode(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function gammaDecode(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Oklch → 8-bit sRGB, clamped into gamut.
 *
 * Clamping (rather than a gamut-mapping algorithm) matches what the browser
 * does to an out-of-gamut `oklch()` closely enough for contrast work, and every
 * token in this theme is inside sRGB anyway. The clamp is there so a future
 * out-of-gamut edit gets a plausible number instead of a NaN that would make an
 * assertion pass by accident.
 */
export function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const L = lp ** 3;
  const M = mp ** 3;
  const S = sp ** 3;

  const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  return [
    Math.round(gammaEncode(r) * 255),
    Math.round(gammaEncode(g) * 255),
    Math.round(gammaEncode(bl) * 255),
  ];
}

/** WCAG relative luminance of an 8-bit sRGB colour. */
export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * gammaDecode(r) + 0.7152 * gammaDecode(g) + 0.0722 * gammaDecode(b);
}

/**
 * Paint `fill` at `alpha` over `backdrop`, in sRGB, the way the compositor does.
 *
 * Tailwind's `bg-destructive/10` compiles to
 * `color-mix(in oklab, var(--destructive) 10%, transparent)`. Mixing with
 * `transparent` in a premultiplied space leaves the colour alone and drops the
 * alpha to 0.1, so the result is the plain token at 10% — and the compositing
 * that follows happens in sRGB.
 */
export function compositeOver(
  fill: readonly [number, number, number],
  alpha: number,
  backdrop: readonly [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(fill[i] * alpha + backdrop[i] * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.x contrast ratio. Symmetric: the lighter colour always goes on top. */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
