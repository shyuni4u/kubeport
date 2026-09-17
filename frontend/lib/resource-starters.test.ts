import { describe, expect, it } from "vitest";
import starters from "./resource-starters.json";
import { resourceStarterFields } from "./resource-starters";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findKindSchema } from "./openapi";
import { fieldSchemaProblems } from "./field-schema";

describe("quick-pick starters", () => {
  it.each(starters)("provides editable fixed fields for $kind", starter => {
    const fields = resourceStarterFields(starter.apiVersion, starter.kind, "example");
    expect(Object.keys(fields).length).toBeGreaterThan(0);
    expect(Object.values(fields).every(f => f.mode === "fixed")).toBe(true);
    expect(JSON.stringify(fields)).not.toContain("__RESOURCE_NAME__");
    expect(fields["metadata.name"]).toBeUndefined();
  });
  it.each(["Deployment", "StatefulSet"])("connects %s selectors and Pod labels", kind => {
    const fields = resourceStarterFields("apps/v1", kind, "example");
    expect(fields["spec.selector.matchLabels.app"]).toEqual({ mode: "fixed", fixedValue: "example" });
    expect(fields["spec.template.metadata.labels.app"]).toEqual(fields["spec.selector.matchLabels.app"]);
    expect(fields["spec.template.spec.containers[0].name"]).toEqual({ mode: "fixed", fixedValue: "app" });
    expect(fields["spec.template.spec.containers[0].image"]).toBeDefined();
  });
  it("keeps CronJob suspended until its schedule is reviewed", () => {
    expect(resourceStarterFields("batch/v1", "CronJob", "example")["spec.suspend"]).toEqual({ mode: "fixed", fixedValue: true });
  });
  it("does not apply builtin defaults to an unrelated custom API", () => {
    expect(resourceStarterFields("custom/v1", "Deployment", "example")).toEqual({});
  });
  it.skipIf(!process.env.STARTER_SCHEMA_DIR).each(starters)("accepts $kind fixed fields against the live kind schema", starter => {
    const doc = JSON.parse(readFileSync(join(process.env.STARTER_SCHEMA_DIR!, `${starter.apiVersion.replace("/", "_")}.json`), "utf8"));
    const schema = findKindSchema(doc, starter.apiVersion.includes("/") ? starter.apiVersion.split("/")[0] : "", "v1", starter.kind);
    expect(schema).not.toBeNull();
    expect(fieldSchemaProblems([{
      kind: starter.kind, name: "example", schema: schema!,
      fields: resourceStarterFields(starter.apiVersion, starter.kind, "example"),
    }])).toEqual([]);
  });
});
