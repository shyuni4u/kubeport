import { describe, expect, it } from "vitest";
import { fieldMatchesSchema, fieldSchemaProblems } from "./field-schema";
import type { UIField } from "@/components/FieldInspector";

const exposed = (type: Extract<UIField, { mode: "exposed" }>["uiSpec"]["type"]): UIField => ({ mode: "exposed", uiSpec: { label: "Test", type } });

describe("editor schema validation", () => {
  it("accepts Kubernetes Quantity strings and numbers without permitting object unions", () => {
    const quantity = { oneOf: [{ type: "string" as const }, { type: "number" as const }] };
    for (const value of ["50m", "128Mi", 0.5]) expect(fieldMatchesSchema(quantity, { mode: "fixed", fixedValue: value })).toBe(true);
    for (const value of [true, {}, [], Infinity]) expect(fieldMatchesSchema(quantity, { mode: "fixed", fixedValue: value })).toBe(false);
    expect(fieldMatchesSchema({ oneOf: [{ type: "string" }, { type: "object" }] }, exposed("string"))).toBe(false);
  });
  it("validates values inside maps against additionalProperties", () => {
    const schema = { type: "object" as const, properties: { labels: { type: "object" as const, additionalProperties: { type: "string" as const } } } };
    expect(fieldSchemaProblems([{ kind: "Deployment", name: "web", schema, fields: {
      'labels["app.kubernetes.io/name"]': { mode: "fixed", fixedValue: "web" },
      "labels.invalid": { mode: "fixed", fixedValue: 42 },
    } }])).toEqual(["Deployment[web].labels.invalid"]);
  });
  it("identifies the reproduced ConfigMap data mismatch", () => {
    expect(fieldSchemaProblems([{ kind: "ConfigMap", name: "configmap-1", fields: { data: exposed("string") }, schema: { type: "object", properties: { data: { type: "object" } } } }])).toEqual(["ConfigMap[configmap-1].data"]);
  });
  it("checks indexed children and quoted property names", () => {
    expect(fieldSchemaProblems([{ kind: "Example", name: "test", fields: { 'items[2]["a.b"]': exposed("string") }, schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { "a.b": { type: "boolean" } } } } } } }])).toEqual(['Example[test].items[2]["a.b"]']);
  });
  it.each(["string", "enum", "autocomplete"] as const)("accepts %s on strings", type => {
    expect(fieldMatchesSchema({ type: "string" }, exposed(type))).toBe(true);
  });
  it("rejects mismatched scalar types and fixed object strings", () => {
    expect(fieldMatchesSchema({ type: "integer" }, exposed("string"))).toBe(false);
    expect(fieldMatchesSchema({ type: "boolean" }, exposed("integer"))).toBe(false);
    expect(fieldMatchesSchema({ type: "object" }, { mode: "fixed", fixedValue: "hi" })).toBe(false);
  });
  it("does not invent schema errors before schemas load", () => {
    expect(fieldSchemaProblems([{ kind: "ConfigMap", name: "test", fields: { data: exposed("string") } }])).toEqual([]);
  });
});
