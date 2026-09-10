import { z, type ZodTypeAny } from "zod";

/**
 * A single field in a template's ui-spec overlay. Discriminated by `type`.
 *
 * `path` is a flat dotted key (e.g. "spec.replicas") that the backend's
 * `template.Render` looks up via `input[f.Path]` — NOT a nested object path.
 */
export type UISpecField =
  | {
      path: string;
      label: string;
      help?: string;
      type: "string";
      default?: string;
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
    }
  | {
      path: string;
      label: string;
      help?: string;
      type: "integer";
      default?: number;
      required?: boolean;
      min?: number;
      max?: number;
    }
  | {
      path: string;
      label: string;
      help?: string;
      type: "boolean";
      default?: boolean;
      required?: boolean;
    }
  | {
      path: string;
      label: string;
      help?: string;
      type: "enum";
      values: string[];
      default?: string;
      required?: boolean;
    }
  | {
      // `autocomplete` is a string with a list of suggested values surfaced
      // via a datalist — admin nudges the choice without restricting it. The
      // backend treats the field exactly like `string` (`values` is advisory),
      // so the zod schema is z.string() with the same length/pattern knobs.
      path: string;
      label: string;
      help?: string;
      type: "autocomplete";
      values: string[];
      default?: string;
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
    };

export type UISpec = { fields: UISpecField[] };

/**
 * Build a Zod schema from a ui-spec. Keys are flat dotted paths; optional
 * fields accept a missing key (undefined); required fields reject it.
 *
 * Integer fields use `z.coerce.number().int()` so HTML form string inputs
 * ("3") are accepted while still validating `min`/`max`.
 */
const KNOWN_TYPES = [
  "string",
  "autocomplete",
  "integer",
  "boolean",
  "enum",
] as const;

/**
 * A RegExp, or null while the pattern is still being typed.
 *
 * `new RegExp("[")` throws, and a lone `[` is one keystroke on the way to
 * every character class anyone has ever written (#164).
 *
 * "safe" here means *it compiles*, and nothing more. A pattern that compiles
 * but backtracks catastrophically (`^(a+)+$`) passes, and the deploy form
 * validates on every keystroke — so an admin can still freeze a user's tab
 * with one. Out of reach for demo visitors, who cannot author templates at
 * all, but not a guarantee this function makes.
 */
function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Fields this spec cannot build a schema for, described for a human.
 *
 * `UISpec` is a compile-time type over YAML the admin is *currently typing*,
 * so nothing guarantees the runtime shape matches it. Rather than trust it,
 * the editor asks what is wrong and says so (#164).
 */
export function uiSpecProblems(spec: UISpec): string[] {
  const out: string[] = [];
  spec.fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    const type: unknown = f?.type;
    if (!KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number])) {
      out.push(`${at}.type: ${JSON.stringify(type ?? null)}`);
      return;
    }
    if (f.type === "enum" && !(Array.isArray(f.values) && f.values.length > 0)) {
      out.push(`${at}.values (enum)`);
    }
    if (f.type === "autocomplete" && !Array.isArray(f.values)) {
      out.push(`${at}.values (autocomplete)`);
    }
    if (
      (f.type === "string" || f.type === "autocomplete") &&
      f.pattern &&
      safeRegExp(f.pattern) === null
    ) {
      out.push(`${at}.pattern`);
    }
  });
  return out;
}

/**
 * The subset of `spec` that can actually be rendered and validated, plus what
 * was left out.
 *
 * This is the trust boundary. `UISpec` is a claim about YAML the admin is
 * mid-keystroke on, so the honest place to check it is once, here, on the way
 * in — after which DynamicForm and everything under it can go on believing
 * the type (#164). Guarding only the schema builder left the widget renderer
 * reading `values.length` off an enum that had none.
 *
 * Fields drop out; the spec is never rejected wholesale. A half-written field
 * should cost the admin that one row of the preview, not the preview.
 */
export function normalizeUISpec(spec: UISpec): {
  spec: UISpec;
  problems: string[];
} {
  const problems = uiSpecProblems(spec);
  const fields = spec.fields.filter((f) => {
    if (!KNOWN_TYPES.includes(f?.type as (typeof KNOWN_TYPES)[number])) {
      return false;
    }
    if (f.type === "enum") {
      return Array.isArray(f.values) && f.values.length > 0;
    }
    return true;
  })
    .map((f) => {
      // A pattern that does not compile yet costs the pattern, not the field.
      // Dropping the whole row would make it blink out of the preview on the
      // way to every character class.
      if ((f.type === "string" || f.type === "autocomplete") && f.pattern) {
        if (safeRegExp(f.pattern) === null) return { ...f, pattern: undefined };
      }
      // `values` is advisory for autocomplete (datalist hints), but the
      // renderer spreads it — so give it an empty list rather than undefined.
      if (f.type === "autocomplete" && !Array.isArray(f.values)) {
        return { ...f, values: [] };
      }
      return f;
    });
  return { spec: { fields }, problems };
}

/**
 * Never throws. A field it cannot describe is left out of the schema instead.
 *
 * It used to do neither. `let zs: ZodTypeAny;` had no initialiser and the
 * switch below had no `default`, so a `type` outside the union — which is one
 * keystroke away at any moment while the ui-spec is being typed — reached
 * `zs.optional()` as `undefined` and threw. This runs inside a `useMemo`, so
 * the throw took out the whole editor page and the unsaved draft with it
 * (#164). An enum with no values threw explicitly for the same net effect.
 *
 * Skipping is the right failure here rather than throwing or substituting a
 * permissive schema: the field simply is not describable yet, the rest of the
 * form stays usable, and `uiSpecProblems` is what tells the admin which ones
 * dropped out and why.
 */
export function schemaFromUISpec(spec: UISpec): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of spec.fields) {
    let zs: ZodTypeAny;
    switch (f.type) {
      // `string` and `autocomplete` share the validation shape — `values`
      // on autocomplete is purely UX (datalist hints), so the zod schema is
      // identical. We keep them as separate discriminants in `UISpecField`
      // so the renderer can pick the right widget, but collapse the schema
      // codepath here to keep both in sync.
      case "string":
      case "autocomplete": {
        let s = z.string();
        if (f.minLength !== undefined) s = s.min(f.minLength);
        if (f.maxLength !== undefined) s = s.max(f.maxLength);
        // Defence in depth — normalizeUISpec drops an uncompilable pattern
        // before it reaches here, but this function must not throw for a
        // caller that skipped it.
        if (f.pattern) {
          const re = safeRegExp(f.pattern);
          if (re) s = s.regex(re);
        }
        zs = s;
        break;
      }
      case "integer": {
        let n = z.coerce.number().int();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        zs = n;
        break;
      }
      case "boolean":
        zs = z.boolean();
        break;
      case "enum": {
        const [first, ...rest] = Array.isArray(f.values) ? f.values : [];
        // `enum:` typed, `values:` not written yet — an ordinary moment while
        // editing, not a broken spec. Leave the field out until it has one.
        if (first === undefined) continue;
        zs = z.enum([first, ...rest]);
        break;
      }
      // Not `never`: the union is a compile-time claim about YAML that is
      // still being typed. See the doc comment.
      default:
        continue;
    }
    shape[f.path] = f.required ? zs : zs.optional();
  }
  return z.object(shape);
}

/**
 * Collect default values from a ui-spec into a flat-keyed record. Only
 * fields with `default !== undefined` are included, so falsy defaults
 * (0, false, "") are preserved.
 */
export function defaultsFromUISpec(spec: UISpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.default !== undefined) out[f.path] = f.default;
  }
  return out;
}
