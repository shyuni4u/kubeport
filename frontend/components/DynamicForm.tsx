"use client";

import { useEffect, useMemo } from "react";
import {
  useForm,
  type Control,
  type ControllerRenderProps,
  type FieldValues,
  type Resolver,
} from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
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
  schemaFromUISpec,
  defaultsFromUISpec,
  type UISpec,
  type UISpecField,
} from "@/lib/ui-spec-to-zod";

// Re-export so existing consumers (e.g. app/catalog/[name]/deploy/page.tsx)
// that `import { UISpec } from "@/components/DynamicForm"` keep working.
export type { UISpec, UISpecField } from "@/lib/ui-spec-to-zod";

type FormShape = Record<string, unknown>;

type Props = {
  spec: UISpec;
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
  disabled?: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
  onChange?: (values: Record<string, unknown>) => void;
};

// React Hook Form treats `.` in field names as a nested-path separator, so a
// spec with path="spec.replicas" would produce `{spec: {replicas: 3}}` — the
// backend's template.Render looks up `input["spec.replicas"]`, not nested.
// We keep internal RHF keys dot-free (zero-width placeholder) and translate
// back to the original dotted paths for defaults / watch / submit.
const PATH_SEP = "\u2063"; // INVISIBLE SEPARATOR, extremely unlikely in real paths.

function encodeKey(path: string): string {
  return path.replaceAll(".", PATH_SEP);
}

function decodeValues(encoded: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(encoded)) {
    out[k.replaceAll(PATH_SEP, ".")] = v;
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

/**
 * Widget selection:
 * - boolean → Switch
 * - integer with both min and max → Slider (+ numeric value display)
 * - integer without full range → Input type="number"
 * - enum with ≤ 4 values → ToggleGroup (single-select)
 * - enum with > 4 values → Select
 * - autocomplete → Input + native HTML5 datalist (free input + suggestions)
 * - string → Input type="text" (with optional pattern hint)
 */
export function DynamicForm({
  spec,
  initialValues,
  submitLabel = "배포하기",
  disabled = false,
  onSubmit,
  onChange,
}: Props) {
  // The zod schema validates flat dotted-keys (`input["spec.replicas"]`), but
  // RHF treats `.` in names as a nested-path separator. We keep RHF field
  // names dot-free (encoded) and write a thin resolver that decodes values
  // before validation, then returns errors flat-keyed by the encoded names.
  const resolver = useMemo<Resolver<FormShape>>(() => {
    const schema = schemaFromUISpec(spec);
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
          errors[encoded] = { type: issue.code, message: issue.message };
        }
      }
      return { values: {}, errors: errors as never };
    };
  }, [spec]);

  const defaults = useMemo<FormShape>(() => {
    const flat = { ...defaultsFromUISpec(spec), ...(initialValues ?? {}) };
    return encodeValues(flat);
  }, [spec, initialValues]);

  const form = useForm<FormShape>({
    resolver,
    defaultValues: defaults,
    mode: "onChange",
  });

  useEffect(() => {
    if (!onChange) return;
    const sub = form.watch((values) => {
      onChange(decodeValues(values as Record<string, unknown>));
    });
    return () => sub.unsubscribe();
  }, [form, onChange]);

  const handleSubmit = form.handleSubmit((values) => {
    onSubmit(decodeValues(values as Record<string, unknown>));
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {spec.fields.map((field) => (
          <FieldRow key={field.path} field={field} control={form.control} />
        ))}
        <div className="flex justify-end">
          <Button type="submit" disabled={disabled}>
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

function FieldRow({
  field,
  control,
}: {
  field: UISpecField;
  control: Control<FormShape>;
}) {
  return (
    <FormField
      control={control}
      name={encodeKey(field.path)}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>
            {field.label}
            {field.required ? (
              <span className="ml-1 text-destructive">*</span>
            ) : null}
          </FormLabel>
          <FormControl>{renderWidget(field, rhf)}</FormControl>
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
          {(field.type === "string" || field.type === "autocomplete") &&
          field.pattern ? (
            <p className="text-xs text-muted-foreground">
              pattern: /{field.pattern}/
            </p>
          ) : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function renderWidget(
  field: UISpecField,
  rhf: ControllerRenderProps<FieldValues, string>,
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
        const current =
          typeof rhf.value === "number"
            ? (rhf.value as number)
            : typeof rhf.value === "string" && rhf.value !== ""
              ? Number(rhf.value)
              : min;
        return (
          <div className="flex items-center gap-3">
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
            <span className="min-w-[2.5rem] text-right text-sm tabular-nums">
              {current}
            </span>
          </div>
        );
      }
      // No full range → plain number input. Empty string → undefined so
      // zod treats the field as missing (important for optional ints).
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
            rhf.onChange(raw === "" ? undefined : Number(raw));
          }}
          onBlur={rhf.onBlur}
          name={rhf.name}
        />
      );
    }

    case "enum": {
      const values = field.values;
      if (values.length <= 4) {
        const current =
          typeof rhf.value === "string" && rhf.value !== "" ? [rhf.value] : [];
        return (
          <ToggleGroup
            value={current}
            onValueChange={(next: string[]) => {
              // Single-select: keep the last-pressed value; unpressing all
              // clears to undefined so validation reflects the state.
              if (next.length === 0) {
                rhf.onChange(undefined);
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
          value={typeof rhf.value === "string" ? rhf.value : undefined}
          onValueChange={(v) => rhf.onChange(v)}
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
