import { z, type ZodTypeAny } from "zod";

import { patternProblem } from "./ui-spec-pattern";

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
 * Integer fields accept number strings ("3") while still validating
 * `min`/`max`, and read null or "" as missing rather than 0 (see integerInput).
 */
const KNOWN_TYPES = [
  "string",
  "autocomplete",
  "integer",
  "boolean",
  "enum",
] as const;

/**
 * A RegExp, or null when the form should not run this pattern.
 *
 * `new RegExp("[")` throws, and a lone `[` is one keystroke on the way to
 * every character class anyone has ever written (#164).
 *
 * It is also null for what `patternProblem` names, even when it compiles:
 * RE2-only syntax, which here either throws or means something else, so the
 * form would run a rule the API does not have (#189); a pattern over 200
 * characters; and a repeated group holding an unlimited repeat (`^(a+)+$`),
 * or any other pattern that can match the same text in exponentially many
 * ways — `(a|a)*`, `(a{1,20})+` — which the form would run on every keystroke
 * until the tab froze (#187). The API refuses all of these on save, so only a
 * version saved before that reaches the form with one — and the API still
 * checks it on deploy.
 */
function safeRegExp(pattern: string): RegExp | null {
  if (patternProblem(pattern) !== null) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * The longest value the form runs a pattern against. The API has no such
 * bound and checks every value on deploy, so a longer one is left to it rather
 * than refused here.
 *
 * Exponential patterns are refused before they get here, and so are three
 * overlapping loops in a row (`^\w*\w*\w*!$`: ~5 ms at 256 characters in V8,
 * ~36 ms at 512, ~280 ms at 1024). What is left can match a text at most two
 * ways per run — two overlapping loops, or an unanchored repeat retried from
 * every position — which grows with the square of the value's length;
 * ui-spec-pattern.test.ts holds every accepted table pattern under 50 ms at 256
 * on adversarial input. 256 covers the longest name-shaped value Kubernetes
 * has (a DNS subdomain, 253).
 */
const MAX_PATTERN_INPUT = 256;

/**
 * Values are the other half of the UTF-16 problem ui-spec-pattern.ts refuses
 * in patterns. A flagless RegExp reads "😀" as two characters and Go as one, so
 * `^[^a]{2}$` would pass it here and fail on deploy. For a value holding any
 * surrogate, the form runs the pattern in Unicode mode instead, which reads
 * code points as Go does, with each lone half turned into U+FFFD the way the
 * API's JSON decoding turns it. A pattern that is not valid in Unicode mode
 * (`\_`, a lone `{`) leaves such a value to the API.
 */
const SURROGATE = /[\uD800-\uDFFF]/;

function unicodeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

function withLoneSurrogatesReplaced(value: string): string {
  return value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : String.fromCharCode(0xfffd)));
}

/**
 * One thing wrong with a ui-spec field. `dropped` means the field is left out
 * of the form; `ignored` means the field stays and only that setting is set
 * aside until it is complete. Both used to reach the admin as "left out, the
 * type is not valid", which was wrong about the second kind twice over: the
 * field was still there, and the type was fine (#197).
 */
export type UISpecIssue = {
  at: string;
  /**
   * `refused` is a pattern kubeport will not save (see ui-spec-pattern.ts). It
   * is set aside like an `ignored` one, but it is finished, so telling the
   * admin to wait until it is complete would be wrong.
   */
  kind: "dropped" | "ignored" | "refused";
};

/**
 * What is wrong with this spec's fields, described for a human.
 *
 * `UISpec` is a compile-time type over YAML the admin is *currently typing*,
 * so nothing guarantees the runtime shape matches it. Rather than trust it,
 * the editor asks what is wrong and says so (#164).
 */
export function uiSpecIssues(spec: UISpec): UISpecIssue[] {
  const out: UISpecIssue[] = [];
  // `fields:` with no value parses to null, and a spec with no `fields` key
  // parses to {}. The backend saves both — ValidateSpec only walks the list —
  // so they reach the deploy form, where neither is a list to walk.
  const list: UISpecField[] = Array.isArray(spec?.fields) ? spec.fields : [];
  list.forEach((f, i) => {
    const at = `fields[${i}]`;
    const type: unknown = f?.type;
    if (!KNOWN_TYPES.includes(type as (typeof KNOWN_TYPES)[number])) {
      out.push({ at: `${at}.type: ${JSON.stringify(type ?? null)}`, kind: "dropped" });
      return;
    }
    if (f.type === "enum" && !(Array.isArray(f.values) && f.values.length > 0)) {
      out.push({ at: `${at}.values (enum)`, kind: "dropped" });
    }
    if (f.type === "autocomplete" && !Array.isArray(f.values)) {
      out.push({ at: `${at}.values (autocomplete)`, kind: "ignored" });
    }
    if (
      (f.type === "string" || f.type === "autocomplete") &&
      f.pattern &&
      safeRegExp(f.pattern) === null
    ) {
      out.push({ at: `${at}.pattern`, kind: patternProblem(f.pattern) === null ? "ignored" : "refused" });
    }
  });
  return out;
}

/** The same issues as plain strings, for callers that only list them. */
export function uiSpecProblems(spec: UISpec): string[] {
  return uiSpecIssues(spec).map((issue) => issue.at);
}

/**
 * What to call a field whose label is blank: the last key of its path
 * (`…metadata.labels` → "labels", `…containers[0].image` → "image",
 * `data["nginx.conf"]` → "nginx.conf"). The editor refuses to save an exposed
 * field without a label, and the API now does too, but a version saved before
 * either can still carry one. A blank label left the input with nothing beside
 * it, which read as "exposing did nothing" (#152); the editor's placeholder
 * already promises this name.
 */
function labelFromPath(path: string): string {
  const m = /(?:\.([A-Za-z_][A-Za-z0-9_]*)|\["([^"]*)"\]|\['([^']*)'\])(?:\[\d+\])*$/.exec(path);
  // `||`, not `??`: the grammar allows an empty quoted key (`data[""]`), and
  // falling back to "" would leave the field as blank as it started.
  return m?.[1] || m?.[2] || m?.[3] || path;
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
  /** Every issue, as uiSpecProblems lists them. */
  problems: string[];
  /** Fields left out of the form. */
  dropped: string[];
  /** Settings set aside while their field stays in the form. */
  ignored: string[];
  /** Patterns set aside because kubeport refuses them on save. */
  refused: string[];
} {
  const issues = uiSpecIssues(spec);
  // Same document-level guard as uiSpecIssues: `fields:` → null, no key →
  // {}. The deploy pages only substitute `{fields: []}` when the whole YAML is
  // empty, so these reach DynamicForm as-is.
  const list: UISpecField[] = Array.isArray(spec?.fields) ? spec.fields : [];
  const fields = list.filter((f) => {
    if (!KNOWN_TYPES.includes(f?.type as (typeof KNOWN_TYPES)[number])) {
      return false;
    }
    if (f.type === "enum") {
      return Array.isArray(f.values) && f.values.length > 0;
    }
    return true;
  })
    .map((f): UISpecField => {
      let out: UISpecField = f;
      // A pattern that does not compile yet costs the pattern, not the field.
      // Dropping the whole row would make it blink out of the preview on the
      // way to every character class.
      if (
        (out.type === "string" || out.type === "autocomplete") &&
        out.pattern &&
        safeRegExp(out.pattern) === null
      ) {
        out = { ...out, pattern: undefined };
      }
      // `values` is advisory for autocomplete (datalist hints), but the
      // renderer spreads it — so give it an empty list rather than undefined.
      if (out.type === "autocomplete" && !Array.isArray(out.values)) {
        out = { ...out, values: [] };
      }
      // DynamicForm renders through here too, so this reaches the real
      // deploy form and not only the editor preview (#152).
      if (typeof out.label !== "string" || !out.label.trim()) {
        out = { ...out, label: labelFromPath(out.path) };
      }
      return out;
    });
  return {
    spec: { fields },
    problems: issues.map((issue) => issue.at),
    dropped: issues.filter((issue) => issue.kind === "dropped").map((issue) => issue.at),
    ignored: issues.filter((issue) => issue.kind === "ignored").map((issue) => issue.at),
    refused: issues.filter((issue) => issue.kind === "refused").map((issue) => issue.at),
  };
}

/**
 * An integer field's value as the form holds it, made ready to check (#309).
 *
 * null, undefined and a blank string are no value: `undefined`, which a
 * required field refuses as missing and an optional one leaves out of the
 * payload. A number string becomes its number ("8080" → 8080), as the number
 * box and stored values may hold one. Anything else — a boolean, an array — is
 * passed on as it is, so it is refused as not a number instead of being turned
 * into 0 or 1 by `Number`.
 */
function integerInput(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : Number(v);
  return v;
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
export function schemaFromUISpec(
  spec: UISpec,
  opts: { keptSecrets?: ReadonlySet<string>; reenterSecrets?: ReadonlySet<string> } = {},
): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of spec.fields) {
    // Moving a release to another version cannot carry a Secret over (#196).
    // Its field starts empty and has to be filled, required or not, or the
    // update would replace the running Secret with a default without a word.
    //
    // A kept Secret is required for the same reason (#288). It starts from the
    // placeholder, so leaving it alone passes; but "enter a new value" empties
    // it, and an optional one sent empty would reach the backend as missing
    // and be filled from the ui-spec default.
    const required =
      f.required || opts.reenterSecrets?.has(f.path) || opts.keptSecrets?.has(f.path);
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
        // A Secret to enter again, or one replacing a kept value, needs a
        // value, not an emptied box.
        if (opts.reenterSecrets?.has(f.path) || opts.keptSecrets?.has(f.path)) s = s.min(1);
        if (f.minLength !== undefined) s = s.min(f.minLength);
        if (f.maxLength !== undefined) s = s.max(f.maxLength);
        // Defence in depth — normalizeUISpec drops an unusable pattern before
        // it reaches here, but this function must not throw or hang for a
        // caller that skipped it.
        const re = f.pattern ? safeRegExp(f.pattern) : null;
        const reUnicode = re && f.pattern ? unicodeRegExp(f.pattern) : null;
        // Not `.regex(re)` behind `.max()`: zod runs every check, so a value
        // over maxLength still reached the pattern. The bound has to sit in
        // front of `re.test` itself. The issue keeps `.regex`'s code, which
        // DynamicForm turns into its "not an allowed format" message.
        zs = re
          ? s.superRefine((v, ctx) => {
              if (v.length > MAX_PATTERN_INPUT) return;
              const halves = SURROGATE.test(v);
              const target = halves ? reUnicode : re;
              if (!target || target.test(halves ? withLoneSurrogatesReplaced(v) : v)) return;
              ctx.addIssue({ code: z.ZodIssueCode.invalid_string, validation: "regex", message: "Invalid" });
            })
          : s;
        break;
      }
      case "integer": {
        // Not `z.coerce.number()`: that is `Number(v)`, which reads null, ""
        // (and false, []) as 0. An emptied kept Secret went out as 0 over the
        // running one (codex review of #288), and a release whose stored
        // values held null for any integer sent 0 on update (#309). Empty is
        // taken out before any number is made of it — missing, so a required
        // field says "required" and an optional one is left out — and what
        // remains is checked without coercion.
        let n = z.number().int();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        // The optional has to sit inside the preprocess: outside, it only lets
        // `undefined` through, and null would reach `n` as missing.
        zs = z.preprocess(integerInput, required ? n : n.optional());
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
    // A release is read back with its Secret values redacted (#196), and the
    // update form starts from that read. A Secret it came back redacted for
    // may be sent back unchanged — the server keeps the value it has — so the
    // placeholder passes whatever the field's own type and constraints are.
    if (opts.keptSecrets?.has(f.path)) {
      zs = z.union([z.literal(REDACTED_SECRET), zs]);
    }
    shape[f.path] = required ? zs : zs.optional();
  }
  return z.object(shape);
}

/** What a release's Secret values read as (#196); see backend secret_redact.go. */
export const REDACTED_SECRET = "<redacted>";

/**
 * Whether a ui-spec path is under a Secret kind, read the way the backend's
 * path grammar reads a kind — the longest run of letters (`^[A-Z][A-Za-z]+`),
 * so `SecretStore` is another kind. Broader than the backend's isSecretPath
 * (data and stringData only) on purpose: it only picks among starting values
 * that were exactly the placeholder, which the backend sends for data and
 * stringData alone — to accept the placeholder back on the same version, and
 * to empty and require the field when an update moves to another version.
 */
export function isSecretPath(path: string): boolean {
  return /^Secret(?![A-Za-z])/.test(path);
}

/** The Secret paths whose starting value is the redacted placeholder. */
export function keptSecretPaths(initialValues: Record<string, unknown> | undefined): Set<string> {
  const kept = new Set<string>();
  for (const [path, value] of Object.entries(initialValues ?? {})) {
    if (value === REDACTED_SECRET && isSecretPath(path)) kept.add(path);
  }
  return kept;
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
