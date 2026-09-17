"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import type { SchemaNode } from "@/lib/openapi";
import { HelpHint } from "@/components/HelpHint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { fieldLabelClass } from "@/components/ui/field-styles";
import { Input } from "@/components/ui/input";
import { mapSchemaType, fieldMatchesSchema } from "@/lib/field-schema";

// Field types the editor supports. `enum` and `autocomplete` both render a
// values list editor (admin-supplied options); the difference is enforcement
// — `enum` rejects values outside the list at deploy time, `autocomplete`
// only suggests them via a datalist and lets the user type anything.
type UISpecType = "string" | "integer" | "boolean" | "enum" | "autocomplete";

export type UIField =
  | { mode: "fixed"; fixedValue: unknown }
  | {
      mode: "exposed";
      uiSpec: {
        label: string;
        type: UISpecType;
        min?: number; max?: number;
        pattern?: string; values?: string[];
        default?: unknown; required?: boolean; help?: string;
      };
    };

// String-compatible types let the admin pick how the field should be
// presented to end-users. The natural type from the OpenAPI schema is the
// default; the toggle in the inspector lets them upgrade plain strings to
// `enum` (strict) or `autocomplete` (suggested + free input).
const STRING_COMPATIBLE: ReadonlyArray<UISpecType> = ["string", "enum", "autocomplete"];

// Builds the ui-spec `path` value (`Kind[metadata.name].json.path`) the
// admin will see in ui-spec.yaml. Falls back to the bare JSON path when the
// caller has no resource context.
export function uiSpecPath(kind: string | undefined, resourceName: string | undefined, path: string): string {
  return kind && resourceName ? `${kind}[${resourceName}].${path}` : path;
}

export function FieldInspector({
  path, node, value, onChange, onClear, kind, resourceName, readOnly = false,
}: {
  path: string;
  node: SchemaNode;
  value: UIField | undefined;
  onChange: (v: UIField) => void;
  onClear: () => void;
  /** Resource kind (e.g. `Deployment`) — used to display the ui-spec path. */
  kind?: string;
  /** Resource metadata.name — used to display the ui-spec path. */
  resourceName?: string;
  /**
   * Show the field's settings without letting them change. Set when the page
   * cannot save what the inspector would edit (a YAML-authored draft opened in
   * UI mode): inputs that accept typing next to a save button that never
   * enables read as broken (#184).
   */
  readOnly?: boolean;
}) {
  const t = useTranslations("templates.editor.field");
  const fixedInputId = useId();
  const mode = value?.mode ?? null;
  const schemaType = mapSchemaType(node);
  const leaf = path.split(".").pop() ?? path;

  return (
    <div className="rounded-[12px] border bg-card p-5 text-sm">
      <div
        className="font-mono text-xs text-muted-foreground mb-2 break-all"
        title={t("uiSpecPathHelp")}
      >
        {uiSpecPath(kind, resourceName, path)}
      </div>
      {/*
        A disabled fieldset disables every control inside it natively, so a
        control added later cannot be missed. min-w-0: a fieldset's default
        min-width is its content, which would stop the inspector shrinking.
      */}
      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
      {!schemaType && <p role="alert" className="mb-3 text-muted-foreground">{t("unsupportedType")}</p>}
      {value && !fieldMatchesSchema(node, value) && <p role="alert" className="mb-3 text-destructive">{t("typeMismatch")}</p>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Button
          type="button"
          variant={mode === "fixed" ? "secondary" : "outline"}
          aria-pressed={mode === "fixed"}
          className={mode === "fixed" ? "border-primary bg-selected text-selected-foreground" : ""}
          disabled={!schemaType}
          onClick={() => schemaType && onChange({ mode: "fixed", fixedValue: defaultFor(schemaType) })}
        >{t("fix")}</Button>
        <HelpHint text={t("fixHelp")} />
        <Button
          type="button"
          variant={mode === "exposed" ? "secondary" : "outline"}
          aria-pressed={mode === "exposed"}
          className={mode === "exposed" ? "border-primary bg-selected text-selected-foreground" : ""}
          disabled={!schemaType}
          onClick={() => schemaType && onChange({ mode: "exposed", uiSpec: { label: "", type: schemaType, required: false } })}
        >{t("expose")}</Button>
        <HelpHint text={t("exposeHelp")} />
        {value && <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={onClear}>{t("clear")}</Button>}
      </div>

      {schemaType && value?.mode === "fixed" && (
        <div>
          <label htmlFor={fixedInputId} className={`${fieldLabelClass} block mb-2`}>{t("value")}</label>
          <Input
            id={fixedInputId}
            value={String(value.fixedValue ?? "")}
            onChange={e => onChange({ mode: "fixed", fixedValue: coerce(e.target.value, schemaType) })}
          />
        </div>
      )}

      {schemaType && value?.mode === "exposed" && fieldMatchesSchema(node, value) && (
        <div className="space-y-4">
          {/*
            Type toggle for string-compatible schema slots. We hide it for
            integer/boolean because the schema type is decisive there. The
            three options map to:
              - "자유 텍스트" (string)         → plain text input
              - "선택지" (enum, strict)        → dropdown / toggle group
              - "추천" (autocomplete, soft)    → text input + datalist hints
            Switching from enum↔autocomplete preserves `values`; switching
            into either from "string" starts with a single empty slot so the
            list editor shows up immediately.
          */}
          {STRING_COMPATIBLE.includes(schemaType) && (
            <fieldset className="min-w-0">
              <legend className={`${fieldLabelClass} mb-2`}>{t("inputMode")}</legend>
              <div className="flex gap-1">
                {(["string", "enum", "autocomplete"] as const).map((ty) => (
                  <Button
                    key={ty}
                    type="button"
                    variant="outline"
                    aria-pressed={value.uiSpec.type === ty}
                    className={value.uiSpec.type === ty ? "flex-1 border-primary bg-selected text-selected-foreground" : "flex-1"}
                    onClick={() => {
                      // Always preserve `values` across type changes — never
                      // auto-seed `[""]`. An auto-seeded empty string for
                      // `enum` produces `z.enum([""])` downstream which
                      // accepts only the literal empty string, leaving admins
                      // wondering why valid inputs get rejected. Admin clicks
                      // "+ 값 추가" to start the list.
                      onChange({
                        ...value,
                        uiSpec: {
                          ...value.uiSpec,
                          type: ty,
                          values: value.uiSpec.values,
                        },
                      });
                    }}
                  >
                    {ty === "string" ? t("freeText") : ty === "enum" ? t("choices") : t("suggest")}
                  </Button>
                ))}
              </div>
            </fieldset>
          )}
          <Labeled label={t("label")} v={value.uiSpec.label}
            placeholder={t("labelPlaceholder", { leaf })}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, label: x } })}/>
          {/* Shown to users as the (?) tooltip and the line under the input. */}
          <Labeled label={t("help")} v={value.uiSpec.help ?? ""}
            placeholder={t("helpPlaceholder")}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, help: x || undefined } })}/>
          <Labeled label={t("default")} v={String(value.uiSpec.default ?? "")}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, default: coerce(x, value.uiSpec.type) } })}/>
          {(value.uiSpec.type === "enum" || value.uiSpec.type === "autocomplete") && (
            <fieldset className="min-w-0">
              <legend className={`${fieldLabelClass} mb-2`}>
                {value.uiSpec.type === "enum" ? t("values") : t("suggestions")}
              </legend>
              <div className="space-y-1">
                {(value.uiSpec.values ?? []).map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      className="flex-1"
                      aria-label={`${value.uiSpec.type === "enum" ? t("values") : t("suggestions")} ${i + 1}`}
                      value={v}
                      onChange={e => {
                        const next = [...(value.uiSpec.values ?? [])];
                        next[i] = e.target.value;
                        onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost" className="text-destructive"
                      onClick={() => {
                        const next = (value.uiSpec.values ?? []).filter((_, j) => j !== i);
                        onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                      }}
                    >{t("remove")}</Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline" className="mt-2"
                  onClick={() => {
                    const next = [...(value.uiSpec.values ?? []), ""];
                    onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                  }}
                >{t("addValue")}</Button>
              </div>
            </fieldset>
          )}
          {value.uiSpec.type === "integer" && (
            <>
              <Labeled label="min" v={String(value.uiSpec.min ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, min: x ? Number(x) : undefined } })}/>
              <Labeled label="max" v={String(value.uiSpec.max ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, max: x ? Number(x) : undefined } })}/>
            </>
          )}
          <Label className="gap-3">
            <Checkbox disabled={readOnly} checked={!!value.uiSpec.required}
              onCheckedChange={checked => onChange({ ...value, uiSpec: { ...value.uiSpec, required: checked } })}/>
            {t("required")}
          </Label>
        </div>
      )}
      </fieldset>
    </div>
  );
}

function Labeled({ label, v, placeholder, onChange }: { label: string; v: string; placeholder?: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`${fieldLabelClass} block mb-2`}>{label}</label>
      <Input id={id} value={v} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function defaultFor(t: UISpecType): unknown {
  if (t === "integer") return 0;
  if (t === "boolean") return false;
  return "";
}

function coerce(raw: string, t: UISpecType): unknown {
  if (t === "integer") return raw === "" ? undefined : Number(raw);
  if (t === "boolean") return raw === "true";
  return raw;
}
