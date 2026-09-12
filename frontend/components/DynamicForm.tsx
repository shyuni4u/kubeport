"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import type { ZodIssue } from "zod";
import {
  useForm,
  useWatch,
  type Control,
  type ControllerRenderProps,
  type FieldValues,
  type Resolver,
} from "react-hook-form";

import { HelpHint } from "@/components/HelpHint";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  REDACTED_SECRET,
  keptSecretPaths,
  schemaFromUISpec,
  defaultsFromUISpec,
  normalizeUISpec,
  type UISpec,
  type UISpecField,
} from "@/lib/ui-spec-to-zod";

// Re-export so existing consumers (e.g. app/catalog/[name]/deploy/page.tsx)
// that `import { UISpec } from "@/components/DynamicForm"` keep working.
export type { UISpec, UISpecField } from "@/lib/ui-spec-to-zod";

type FormShape = Record<string, unknown>;

/**
 * The form's values as submit would send them, or that submit would refuse
 * them. `values` is the schema's output: an optional field with no value is
 * left out, a kept Secret's placeholder passes as it is.
 */
export type ParsedFormValues =
  | { success: true; values: Record<string, unknown> }
  | { success: false };

type Props = {
  spec: UISpec;
  initialValues?: Record<string, unknown>;
  /**
   * Secret paths an update to another version has to be given again (#196).
   * They start empty — no ui-spec default either — are required, and say why.
   */
  reenterSecrets?: readonly string[];
  submitLabel?: string;
  /**
   * Emphasis of the submit button. The admin's ui-spec preview passes
   * "outline" so the button that deploys nothing stops outshouting the
   * editor's real save action (#44).
   */
  submitVariant?: "default" | "outline";
  disabled?: boolean;
  /**
   * May return a promise. When it does, the form stays locked until it
   * settles so a second click cannot fire a second request (#31).
   */
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  /** The raw values the form holds, on first paint and every change. */
  onChange?: (values: Record<string, unknown>) => void;
  /**
   * The same moments as onChange, parsed by the schema the submit uses (#319).
   * The deploy form's preview used the raw values: a stored null reached the
   * render API, which refused it, while submit would have left the key out.
   * Building the payload here, from the one schema, keeps the two from
   * drifting apart again.
   */
  onParsedChange?: (parsed: ParsedFormValues) => void;
};

// React Hook Form treats `.` in field names as a nested-path separator, so a
// spec with path="spec.replicas" would produce `{spec: {replicas: 3}}` — the
// backend's template.Render looks up `input["spec.replicas"]`, not nested.
// We keep internal RHF keys dot-free (zero-width placeholder) and translate
// back to the original dotted paths for defaults / watch / submit.
// RHF's stringToPath also splits on `[` and `]`, so `Deployment[web].spec`
// and `containers[0]` would be nested too. All three get their own invisible
// placeholder (U+2063 INVISIBLE SEPARATOR, U+2064 INVISIBLE PLUS, U+2062
// INVISIBLE TIMES) \u2014 extremely unlikely in real paths.
// Enum values longer than this switch the widget from ToggleGroup to Select.
const TOGGLE_MAX_LEN = 24;

const PATH_SEP = "\u2063";
const BRACKET_OPEN = "\u2064";
const BRACKET_CLOSE = "\u2062";

function encodeKey(path: string): string {
  return path
    .replaceAll(".", PATH_SEP)
    .replaceAll("[", BRACKET_OPEN)
    .replaceAll("]", BRACKET_CLOSE);
}

function decodeKey(key: string): string {
  return key
    .replaceAll(PATH_SEP, ".")
    .replaceAll(BRACKET_OPEN, "[")
    .replaceAll(BRACKET_CLOSE, "]");
}

function decodeValues(encoded: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(encoded)) {
    out[decodeKey(k)] = v;
  }
  return out;
}

function encodeValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[encodeKey(k)] = v;
  }
  return out;
}

type IntegerField = Extract<UISpecField, { type: "integer" }>;

/**
 * True for an integer field that gets a Slider rather than a number Input.
 *
 * A type predicate, not a boolean: `min`/`max` live only on the integer arm of
 * the UISpecField union, so callers need the narrowing to read them.
 */
function isRangedInteger(field: UISpecField): field is IntegerField {
  return (
    field.type === "integer" &&
    field.min !== undefined &&
    field.max !== undefined
  );
}

/**
 * Current value of a ranged integer, with the same coercion the Slider uses.
 *
 * Shared so the readout beside the label and the thumb can never disagree —
 * they are rendered in different parts of the tree (see the readout's comment
 * in FieldRow).
 */
function rangedIntValue(field: IntegerField, value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  return field.min!;
}

/**
 * Widget selection:
 * - boolean → Switch
 * - integer with both min and max → Slider (value shown on the label row)
 * - integer without full range → Input type="number"
 * - enum with ≤ 4 values → ToggleGroup (single-select)
 * - enum with > 4 values → Select
 * - autocomplete → Input + native HTML5 datalist (free input + suggestions)
 * - string → Input type="text" (with optional pattern hint)
 */
export function DynamicForm({
  spec: rawSpec,
  initialValues,
  reenterSecrets,
  submitLabel = "배포하기",
  submitVariant = "default",
  disabled = false,
  onSubmit,
  onChange,
  onParsedChange,
}: Props) {
  // The trust boundary sits here, not in the callers (#164).
  //
  // It started one level up, in UserFormPreview, which covered the admin's
  // preview and missed the deploy form — DeployClient hands the server's
  // ui-spec straight to this component. That gap mattered once
  // `schemaFromUISpec` stopped throwing on an undescribable field: the field
  // left the schema but `spec.fields.map` below still rendered its row,
  // `renderWidget` returned undefined for it, and FormControl's
  // `React.cloneElement(children, …)` threw on that undefined — moving the
  // crash from the validator to the renderer, in the one place that has no
  // error boundary.
  //
  // Normalising here instead means every entry point is covered exactly once,
  // and the schema and the rendered rows are built from the same field list
  // by construction. It is idempotent, so a caller that already normalised
  // (UserFormPreview does, to report what dropped) costs nothing.
  const spec = useMemo(() => normalizeUISpec(rawSpec).spec, [rawSpec]);

  // The zod schema validates flat dotted-keys (`input["spec.replicas"]`), but
  // RHF treats `.` in names as a nested-path separator. We keep RHF field
  // names dot-free (encoded) and write a thin resolver that decodes values
  // before validation, then returns errors flat-keyed by the encoded names.
  const tv = useTranslations("form.validation");
  const keptSecrets = useMemo(() => keptSecretPaths(initialValues), [initialValues]);
  const reenter = useMemo(() => new Set(reenterSecrets ?? []), [reenterSecrets]);
  // One instance for the resolver (what submit sends) and onParsedChange
  // (what the deploy form previews), so they cannot disagree.
  const schema = useMemo(
    () => schemaFromUISpec(spec, { keptSecrets, reenterSecrets: reenter }),
    [spec, keptSecrets, reenter],
  );
  const resolver = useMemo<Resolver<FormShape>>(() => {
    // Zod's default messages are English developer strings ("Required",
    // "String must contain at most 80 character(s)"). Translate by issue
    // code so non-k8s users get a plain-language sentence in their locale.
    const messageFor = (issue: ZodIssue): string => {
      switch (issue.code) {
        case "invalid_type":
          return issue.received === "undefined" || issue.received === "null"
            ? tv("required")
            : tv("invalid");
        case "too_small":
          // A required string with min length 1 left empty reads better as
          // "required" than "must be at least 1".
          if (issue.type === "string" && Number(issue.minimum) <= 1) {
            return tv("required");
          }
          if (issue.type === "string") {
            return tv("tooShort", { min: String(issue.minimum) });
          }
          return tv("tooSmall", { min: String(issue.minimum) });
        case "too_big":
          // For strings the bound is a character count, not a numeric limit.
          if (issue.type === "string") {
            return tv("tooLong", { max: String(issue.maximum) });
          }
          return tv("tooBig", { max: String(issue.maximum) });
        case "invalid_string":
          return tv("pattern");
        case "invalid_enum_value":
          return tv("enum");
        case "invalid_union": {
          // Only a kept Secret's schema is a union: the placeholder, or the
          // field's own type (#196). Once it is not the placeholder, the
          // field's own complaint is the one worth saying — "required" for an
          // emptied replacement rather than a generic "check this value".
          const own = issue.unionErrors.at(-1)?.issues[0];
          return own ? messageFor(own) : tv("invalid");
        }
        default:
          return tv("invalid");
      }
    };
    return async (values) => {
      const decoded = decodeValues(values as Record<string, unknown>);
      const result = schema.safeParse(decoded);
      if (result.success) {
        return { values: encodeValues(result.data) as FormShape, errors: {} };
      }
      // Map each zod issue's dotted path to our encoded RHF field name.
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const flatPath = issue.path.join(".");
        const encoded = encodeKey(flatPath);
        if (!errors[encoded]) {
          errors[encoded] = { type: issue.code, message: messageFor(issue) };
        }
      }
      return { values: {}, errors: errors as never };
    };
  }, [schema, tv]);

  const defaults = useMemo<FormShape>(() => {
    const flat = { ...defaultsFromUISpec(spec), ...(initialValues ?? {}) };
    // A default here would go out as the Secret's new value, unseen.
    for (const path of reenter) delete flat[path];
    return encodeValues(flat);
  }, [spec, initialValues, reenter]);

  const form = useForm<FormShape>({
    resolver,
    defaultValues: defaults,
    mode: "onChange",
  });

  useEffect(() => {
    if (!onChange && !onParsedChange) return;
    const emit = (values: Record<string, unknown>) => {
      const decoded = decodeValues(values);
      onChange?.(decoded);
      if (!onParsedChange) return;
      // The resolver's parse, on the same decoded values: submit sends
      // `result.data` (the resolver returns it, handleSubmit decodes it).
      const result = schema.safeParse(decoded);
      onParsedChange(result.success ? { success: true, values: result.data } : { success: false });
    };
    // RHF's watch() only emits on *change*, so a user who accepts every
    // default never triggered a render preview — and therefore never
    // triggered the RBAC preflight that gates the submit button (#30).
    // Emit the initial values once so both are live from first paint.
    emit(form.getValues() as Record<string, unknown>);
    const sub = form.watch((values) => {
      emit(values as Record<string, unknown>);
    });
    return () => sub.unsubscribe();
  }, [form, onChange, onParsedChange, schema]);

  // A ref, not state: the second click of a double-click arrives in the same
  // tick as the first, before any re-render could flip a `disabled` prop. The
  // parent's own `disabled` is therefore always one render too late (#31).
  const inFlight = useRef(false);
  const handleSubmit = form.handleSubmit(async (values) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await onSubmit(decodeValues(values as Record<string, unknown>));
    } finally {
      inFlight.current = false;
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {spec.fields.map((field) => (
          <FieldRow
            key={field.path}
            field={field}
            control={form.control}
            reenter={reenter.has(field.path)}
            kept={keptSecrets.has(field.path)}
          />
        ))}
        <div className="flex justify-end">
          {/*
            isSubmitting mirrors the ref guard for the visible state: awaiting
            onSubmit above keeps it true for the whole request, so the button
            greys out instead of merely swallowing the click.
          */}
          <Button
            type="submit"
            variant={submitVariant}
            disabled={disabled || form.formState.isSubmitting}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// autocompleteListId is path-scoped so multiple autocomplete fields on the
// same form don't share suggestion lists. Uses only [A-Za-z0-9_-] which are
// valid id characters in HTML, even though the spec is more permissive.
function autocompleteListId(path: string): string {
  return `dyn-suggest-${path.replace(/[^A-Za-z0-9]/g, "-")}`;
}

/**
 * What "enter a new value" puts in place of the kept placeholder (#288).
 *
 * Never a ui-spec default: that is the value an unseen overwrite would have
 * sent. A Switch and a Slider have no empty state, so they start at a value
 * they visibly show — off, and the minimum (a bound, printed by the readout
 * beside the label) — which is exactly what they submit. Everything else starts
 * empty and is refused until filled; an integer box never reads empty as 0
 * (see schemaFromUISpec).
 *
 * Empty is `null`, not `undefined`: react-hook-form reads an undefined field
 * back as its default value, which here is the placeholder, so the field would
 * snap back to "kept" the moment it was emptied.
 */
function replacementValue(field: UISpecField): unknown {
  switch (field.type) {
    case "boolean":
      return false;
    case "integer":
      return isRangedInteger(field) ? field.min : null;
    case "enum":
      return null;
    default:
      return "";
  }
}

/** The first thing in a field's control area a keyboard can land on. */
const FOCUSABLE =
  'input:not([type="hidden"]):not([tabindex="-1"]):not([aria-hidden="true"]), button:not([tabindex="-1"]), [role="switch"], [role="slider"], [tabindex="0"]';

/**
 * A Secret the update keeps as it is (#288). It replaces the typed widget,
 * which could only misrepresent the placeholder: NaN on a Slider, "on" for a
 * stored false, nothing selected in an enum.
 *
 * The button is not given the field's id, so clicking the label does not
 * activate it — replacing a Secret should take a deliberate press.
 */
function KeptSecret({ label, onReplace }: { label: string; onReplace: () => void }) {
  const tf = useTranslations("form");
  const { formItemId, formDescriptionId } = useFormField();
  const statusId = `${formItemId}-kept`;
  return (
    <div
      data-slot="kept-secret"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2"
    >
      <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span id={statusId} className="min-w-0 flex-1 text-sm text-muted-foreground">
        {tf("secretKept.status")}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={tf("secretKept.replaceAria", { label })}
        aria-describedby={`${statusId} ${formDescriptionId}`}
        onClick={onReplace}
      >
        {tf("secretKept.replace")}
      </Button>
    </div>
  );
}

function FieldRow({
  field,
  control,
  reenter = false,
  kept = false,
}: {
  field: UISpecField;
  control: Control<FormShape>;
  reenter?: boolean;
  /** A Secret the release came back redacted for (#196). */
  kept?: boolean;
}) {
  const tv = useTranslations("form.validation");
  const tf = useTranslations("form");
  const name = encodeKey(field.path);
  // Kept until someone asks to replace it; back to kept when they ask again.
  // Emptying a replacement does not return here — pulling the input out from
  // under someone mid-edit would be worse — and an empty replacement is
  // refused on submit instead (see schemaFromUISpec).
  const current = useWatch({ control, name });
  const keeping = kept && current === REDACTED_SECRET;

  // Either swap removes the button that was just pressed, so focus would
  // fall to <body>. Move it to what took the button's place.
  const area = useRef<HTMLDivElement>(null);
  const focusAfterSwap = useRef(false);
  useEffect(() => {
    if (!focusAfterSwap.current) return;
    focusAfterSwap.current = false;
    area.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [keeping]);

  return (
    <FormField
      control={control}
      name={name}
      render={({ field: rawRhf }) => {
        // See replacementValue: an emptied kept field is null, never undefined.
        const rhf = kept
          ? { ...rawRhf, onChange: (v: unknown) => rawRhf.onChange(v === undefined ? null : v) }
          : rawRhf;
        return (
        <FormItem>
          {/*
            HelpHint sits beside the label, not inside it: a <button> inside
            <label for=…> is invalid HTML and its aria-label would leak into
            the input's accessible name ("환영 문구 도움말").
          */}
          <div className="flex items-center gap-1">
            <FormLabel>
              {field.label}
              {field.required || reenter || (kept && !keeping) ? (
                <span className="ml-1 text-destructive">*</span>
              ) : null}
            </FormLabel>
            {field.help ? <HelpHint text={field.help} /> : null}
            {/*
              The slider's readout lives here, not next to the max label where
              it started: sitting 8px from it on the same baseline, "1 … 3 1"
              read as two range ends and a stray number, and at value == max it
              became "3 3" (#113). On the label row it is unambiguously "this
              field's current value", and the row below is left as a clean
              min/max scale.

              A sibling of <FormLabel>, never a child — it must not join the
              control's accessible name. Screen readers already get the value
              from the thumb's <input type="range">.

              Not while a Secret is kept: there is no value to read out (#288).
            */}
            {isRangedInteger(field) && !keeping ? (
              <span
                data-testid="slider-value"
                aria-hidden="true"
                className="ml-auto text-sm font-medium tabular-nums"
              >
                {rangedIntValue(field, rhf.value)}
              </span>
            ) : null}
          </div>
          <div ref={area}>
            {keeping ? (
              <KeptSecret
                label={field.label}
                onReplace={() => {
                  focusAfterSwap.current = true;
                  rhf.onChange(replacementValue(field));
                }}
              />
            ) : (
              <FormControl>
                {/* Required as the schema reads it: a kept or re-entered Secret too. */}
                {renderWidget(field, rhf, Boolean(field.required || reenter || kept))}
              </FormControl>
            )}
          </div>
          {/*
            Autocomplete renders an <Input list="..."> via renderWidget. The
            matching <datalist> must be a sibling (not a child of the Input)
            and we keep it outside <FormControl> so shadcn's Slot can still
            forward the label/aria-* to the Input cleanly.
          */}
          {field.type === "autocomplete" && (
            <datalist id={autocompleteListId(field.path)}>
              {/*
                Dedup with Set — admin-supplied lists shouldn't have dupes
                but defending against accidental "+ 값 추가" double-clicks
                avoids React's duplicate-key warning at the very least.
              */}
              {Array.from(new Set(field.values)).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          )}
          {field.help ? <FormDescription>{field.help}</FormDescription> : null}
          {/*
            When the admin gave no plain-language help for a pattern-
            constrained field, say only that a format exists — the raw
            regex means nothing to a non-technical user.
          */}
          {(field.type === "string" || field.type === "autocomplete") &&
          field.pattern &&
          !field.help ? (
            <p className="text-xs text-muted-foreground">{tv("hasPattern")}</p>
          ) : null}
          {reenter ? (
            <p className="text-xs text-muted-foreground">{tf("secretReenter")}</p>
          ) : null}
          {kept && !keeping ? (
            <div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0"
                aria-label={tf("secretKept.keepAria", { label: field.label })}
                onClick={() => {
                  focusAfterSwap.current = true;
                  rhf.onChange(REDACTED_SECRET);
                }}
              >
                <Lock aria-hidden="true" />
                {tf("secretKept.keep")}
              </Button>
            </div>
          ) : null}
          <FormMessage />
        </FormItem>
        );
      }}
    />
  );
}

function renderWidget(
  field: UISpecField,
  rhf: ControllerRenderProps<FieldValues, string>,
  required: boolean,
) {
  switch (field.type) {
    case "boolean":
      return (
        <Switch
          checked={Boolean(rhf.value)}
          onCheckedChange={(v) => rhf.onChange(v)}
        />
      );

    case "integer": {
      const hasRange = field.min !== undefined && field.max !== undefined;
      if (hasRange) {
        const min = field.min!;
        const max = field.max!;
        const current = rangedIntValue(field, rhf.value);
        // The end labels are not decoration: without them a slider whose
        // thumb sits at an end is indistinguishable from a disabled control,
        // and a non-k8s user has no way to know how far the range goes (#43).
        return (
          <div className="flex items-center gap-2">
            <span
              data-testid="slider-min"
              className="text-[11px] tabular-nums text-muted-foreground"
            >
              {min}
            </span>
            <Slider
              min={min}
              max={max}
              value={[current]}
              onValueChange={(v: number | readonly number[]) => {
                const next = Array.isArray(v) ? v[0] : (v as number);
                rhf.onChange(next);
              }}
              className="flex-1"
            />
            <span
              data-testid="slider-max"
              className="text-[11px] tabular-nums text-muted-foreground"
            >
              {max}
            </span>
          </div>
        );
      }
      // No full range → plain number input. An empty box is null (#321), not
      // undefined: react-hook-form reads an undefined field back from its
      // default values, so a ui-spec default came back into the box the
      // moment it was cleared, and typing appended to it (3, clear, 5 → 35).
      // The schema reads null as no value (integerInput): required says
      // "required", optional leaves the key out. A lone "-" or other partial
      // input the browser cannot parse also reads as "" and lands here, which
      // keeps it on screen instead of being overwritten by the default.
      return (
        <Input
          type="number"
          min={field.min}
          max={field.max}
          value={
            rhf.value === undefined || rhf.value === null
              ? ""
              : String(rhf.value)
          }
          onChange={(e) => {
            const raw = e.target.value;
            rhf.onChange(raw === "" ? null : Number(raw));
          }}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
    }

    case "enum": {
      const values = field.values;
      // Toggle buttons only when every option fits on one row; long values
      // (image refs, URLs) overflow the form, so they get a Select instead.
      if (values.length <= 4 && values.every((v) => v.length <= TOGGLE_MAX_LEN)) {
        const current =
          typeof rhf.value === "string" && rhf.value !== "" ? [rhf.value] : [];
        return (
          <ToggleGroup
            value={current}
            onValueChange={(next: string[], details) => {
              // Pressing the picked item again is the only way to an empty
              // group (#323). It used to store undefined, and react-hook-form
              // reads an undefined field back from its default values: the
              // ui-spec default still looked pressed while the form held
              // nothing, the same root as the number box in #321.
              if (next.length === 0) {
                // Required works like radio buttons. Base UI's toggle group
                // has no "no deselect" option in single mode, so the press is
                // cancelled; the controlled value keeps the item pressed.
                if (required) {
                  details.cancel();
                  return;
                }
                // Optional clears to null, which react-hook-form keeps and the
                // schema reads as no value: nothing pressed, key left out.
                rhf.onChange(null);
                return;
              }
              rhf.onChange(next[next.length - 1]);
            }}
          >
            {values.map((v) => (
              <ToggleGroupItem key={v} value={v}>
                {v}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        );
      }
      return (
        <Select
          // null, not undefined, for no value: Base UI reads an undefined
          // value as uncontrolled and would then show its own last pick
          // instead of what the form holds.
          value={typeof rhf.value === "string" && rhf.value !== "" ? rhf.value : null}
          onValueChange={(v) => {
            // Picking the picked option again picks it again; a single Select
            // has no un-pick from the list. Should it ever report no value,
            // the same rule as the toggle group applies (#323).
            if (v === null) {
              if (!required) rhf.onChange(null);
              return;
            }
            rhf.onChange(v);
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {values.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case "autocomplete":
      // Native HTML5 datalist gives free input + dropdown of suggestions.
      // The matching <datalist> is rendered by FieldRow as a sibling so
      // FormControl's Slot can keep forwarding label/aria-* to the Input.
      return (
        <Input
          type="text"
          list={autocompleteListId(field.path)}
          placeholder={field.placeholder}
          value={typeof rhf.value === "string" ? rhf.value : ""}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );

    case "string":
    default:
      return (
        <Input
          type="text"
          placeholder={
            field.type === "string" ? field.placeholder : undefined
          }
          value={typeof rhf.value === "string" ? rhf.value : ""}
          onChange={(e) => rhf.onChange(e.target.value)}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
  }
}
