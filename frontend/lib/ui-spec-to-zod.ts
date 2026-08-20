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
        if (f.pattern) s = s.regex(new RegExp(f.pattern));
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
        const [first, ...rest] = f.values;
        if (first === undefined) {
          throw new Error(
            `ui-spec field "${f.path}" is enum but has no values`,
          );
        }
        zs = z.enum([first, ...rest]);
        break;
      }
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
