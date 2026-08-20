"use client";

import type { SchemaNode } from "@/lib/openapi";

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

export function FieldInspector({
  path, node, value, onChange, onClear,
}: {
  path: string;
  node: SchemaNode;
  value: UIField | undefined;
  onChange: (v: UIField) => void;
  onClear: () => void;
}) {
  const mode = value?.mode ?? null;
  const schemaType = mapSchemaType(node);

  return (
    <div className="border rounded p-4 text-sm">
      <div className="font-mono text-xs text-muted-foreground mb-2">{path}</div>
      <div className="flex gap-2 mb-3">
        <button
          className={`px-2 py-1 rounded text-xs ${mode === "fixed" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => onChange({ mode: "fixed", fixedValue: defaultFor(schemaType) })}
        >값 고정</button>
        <button
          className={`px-2 py-1 rounded text-xs ${mode === "exposed" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
          onClick={() => onChange({ mode: "exposed", uiSpec: { label: path, type: schemaType, required: false } })}
        >사용자 노출</button>
        {value && <button className="ml-auto text-xs text-red-600" onClick={onClear}>초기화</button>}
      </div>

      {value?.mode === "fixed" && (
        <div>
          <label className="block text-xs mb-1">값</label>
          <input
            className="border rounded px-2 py-1 w-full"
            value={String(value.fixedValue ?? "")}
            onChange={e => onChange({ mode: "fixed", fixedValue: coerce(e.target.value, schemaType) })}
          />
        </div>
      )}

      {value?.mode === "exposed" && (
        <div className="space-y-2">
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
            <div>
              <label className="block text-xs mb-1">입력 방식</label>
              <div className="flex gap-1">
                {(["string", "enum", "autocomplete"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`flex-1 px-2 py-1 rounded text-xs ${
                      value.uiSpec.type === t
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
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
                          type: t,
                          values: value.uiSpec.values,
                        },
                      });
                    }}
                  >
                    {t === "string" ? "자유 텍스트" : t === "enum" ? "선택지" : "추천"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Labeled label="라벨" v={value.uiSpec.label}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, label: x } })}/>
          <Labeled label="기본값" v={String(value.uiSpec.default ?? "")}
            onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, default: coerce(x, value.uiSpec.type) } })}/>
          {(value.uiSpec.type === "enum" || value.uiSpec.type === "autocomplete") && (
            <div>
              <label className="block text-xs mb-1">
                {value.uiSpec.type === "enum" ? "선택지 (Values)" : "추천 항목 (Suggestions)"}
              </label>
              <div className="space-y-1">
                {(value.uiSpec.values ?? []).map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      className="border rounded px-2 py-1 flex-1"
                      value={v}
                      onChange={e => {
                        const next = [...(value.uiSpec.values ?? [])];
                        next[i] = e.target.value;
                        onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                      }}
                    />
                    <button
                      type="button"
                      className="text-xs text-red-600 px-2"
                      onClick={() => {
                        const next = (value.uiSpec.values ?? []).filter((_, j) => j !== i);
                        onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                      }}
                    >삭제</button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-xs text-primary mt-1"
                  onClick={() => {
                    const next = [...(value.uiSpec.values ?? []), ""];
                    onChange({ ...value, uiSpec: { ...value.uiSpec, values: next } });
                  }}
                >+ 값 추가</button>
              </div>
            </div>
          )}
          {value.uiSpec.type === "integer" && (
            <>
              <Labeled label="min" v={String(value.uiSpec.min ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, min: x ? Number(x) : undefined } })}/>
              <Labeled label="max" v={String(value.uiSpec.max ?? "")}
                onChange={x => onChange({ ...value, uiSpec: { ...value.uiSpec, max: x ? Number(x) : undefined } })}/>
            </>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!value.uiSpec.required}
              onChange={e => onChange({ ...value, uiSpec: { ...value.uiSpec, required: e.target.checked } })}/>
            필수 입력
          </label>
        </div>
      )}
    </div>
  );
}

function Labeled({ label, v, onChange }: { label: string; v: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs mb-1">{label}</label>
      <input className="border rounded px-2 py-1 w-full" value={v} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function mapSchemaType(n: SchemaNode): UISpecType {
  if (n.enum) return "enum";
  if (n.type === "integer" || n.type === "number") return "integer";
  if (n.type === "boolean") return "boolean";
  return "string";
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
