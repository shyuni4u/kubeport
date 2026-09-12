import { describe, it, expect } from "vitest";
import {
  REDACTED_SECRET,
  isSecretPath,
  keptSecretPaths,
  schemaFromUISpec,
  type UISpec,
} from "./ui-spec-to-zod";

// #196: a release reads back with its Secret values redacted, and the update
// form starts from that read. A Secret left untouched is sent back as the
// placeholder, which the server turns back into the stored value — so the form
// must not refuse the placeholder for a field whose type or constraints it does
// not meet (codex review).

const spec: UISpec = {
  fields: [
    { path: "Deployment[web].spec.replicas", label: "Replicas", type: "integer", min: 1, max: 10, required: true },
    { path: "Secret[app].stringData.PORT", label: "Port", type: "integer", min: 1, max: 65535, required: true },
    { path: "Secret.stringData.TOKEN", label: "Token", type: "string", pattern: "^[A-Za-z0-9]+$", required: true },
  ],
};

describe("isSecretPath", () => {
  it("recognises a Secret by selector or by kind alone", () => {
    expect(isSecretPath("Secret[app].stringData.PORT")).toBe(true);
    expect(isSecretPath("Secret.stringData.TOKEN")).toBe(true);
    expect(isSecretPath("Secret_x.y")).toBe(true);
    expect(isSecretPath("SecretStore[vault].spec.provider")).toBe(false);
    expect(isSecretPath("Deployment[web].spec.replicas")).toBe(false);
  });
});

describe("keptSecretPaths", () => {
  it("keeps only Secret paths whose value is the placeholder", () => {
    const kept = keptSecretPaths({
      "Deployment[web].spec.replicas": REDACTED_SECRET,
      "Secret[app].stringData.PORT": REDACTED_SECRET,
      "Secret.stringData.TOKEN": "typed",
    });
    expect([...kept]).toEqual(["Secret[app].stringData.PORT"]);
  });
});

describe("schemaFromUISpec with kept secrets", () => {
  const redacted = {
    "Deployment[web].spec.replicas": 3,
    "Secret[app].stringData.PORT": REDACTED_SECRET,
    "Secret.stringData.TOKEN": REDACTED_SECRET,
  };

  it("accepts the placeholder for a kept Secret whatever its type and pattern", () => {
    const schema = schemaFromUISpec(spec, { keptSecrets: keptSecretPaths(redacted) });
    expect(schema.safeParse(redacted).success).toBe(true);
  });

  it("still validates a new value typed over it", () => {
    const schema = schemaFromUISpec(spec, { keptSecrets: keptSecretPaths(redacted) });
    expect(schema.safeParse({ ...redacted, "Secret[app].stringData.PORT": 0 }).success).toBe(false);
    expect(schema.safeParse({ ...redacted, "Secret[app].stringData.PORT": 8080 }).success).toBe(true);
  });

  it("refuses the placeholder where the form did not start from it", () => {
    const schema = schemaFromUISpec(spec);
    expect(schema.safeParse(redacted).success).toBe(false);
  });

  // #288: "enter a new value" empties a kept field. Sent empty, an optional one
  // would reach the backend as missing and be filled from the ui-spec default,
  // over the running Secret. A kept Secret therefore always needs a value: the
  // placeholder it started with, or a real one.
  it("refuses an emptied kept Secret even where the ui-spec makes it optional", () => {
    const optional: UISpec = {
      fields: [
        { path: "Secret[app].stringData.PASSWORD", label: "Password", type: "string", default: "changeme" },
        { path: "Secret[app].stringData.PORT", label: "Port", type: "integer", default: 80 },
        { path: "Secret[app].stringData.DEBUG", label: "Debug", type: "boolean", default: true },
      ],
    };
    const start: Record<string, unknown> = {
      "Secret[app].stringData.PASSWORD": REDACTED_SECRET,
      "Secret[app].stringData.PORT": REDACTED_SECRET,
      "Secret[app].stringData.DEBUG": REDACTED_SECRET,
    };
    const schema = schemaFromUISpec(optional, { keptSecrets: keptSecretPaths(start) });
    expect(schema.safeParse(start).success).toBe(true);
    expect(schema.safeParse({ ...start, "Secret[app].stringData.PASSWORD": "" }).success).toBe(false);
    for (const path of Object.keys(start)) {
      const { [path]: _gone, ...rest } = start;
      void _gone;
      expect(schema.safeParse(rest).success).toBe(false);
    }
    expect(schema.safeParse({ ...start, "Secret[app].stringData.DEBUG": false }).success).toBe(true);
  });

  it("does not accept the placeholder for a field outside a Secret", () => {
    const values = { ...redacted, "Deployment[web].spec.replicas": REDACTED_SECRET };
    const schema = schemaFromUISpec(spec, { keptSecrets: keptSecretPaths(values) });
    expect(schema.safeParse(values).success).toBe(false);
  });
});

// Security review: an update to another version cannot keep a Secret, so the
// form empties it. An optional Secret left empty would otherwise go out as
// nothing, or as the ui-spec default, over the running Secret without a word.
describe("schemaFromUISpec with secrets to enter again", () => {
  const optional: UISpec = {
    fields: [
      { path: "Secret[app].stringData.PASSWORD", label: "Password", type: "string", default: "changeme" },
    ],
  };
  const path = "Secret[app].stringData.PASSWORD";

  it("requires the field even though the ui-spec does not", () => {
    const schema = schemaFromUISpec(optional, { reenterSecrets: new Set([path]) });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ [path]: "" }).success).toBe(false);
    expect(schema.safeParse({ [path]: "s3cret" }).success).toBe(true);
  });

  it("leaves the field optional otherwise", () => {
    expect(schemaFromUISpec(optional).safeParse({}).success).toBe(true);
  });
});
