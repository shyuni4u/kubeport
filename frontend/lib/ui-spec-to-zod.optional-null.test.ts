import { describe, it, expect } from "vitest";
import type { ZodIssue } from "zod";
import {
  REDACTED_SECRET,
  keptSecretPaths,
  schemaFromUISpec,
  type UISpec,
  type UISpecField,
} from "./ui-spec-to-zod";

// #316: string, autocomplete, boolean and enum fields used `.optional()`, which
// lets only `undefined` through. An update form starts from the release's
// stored values, and a stored null failed the type check, which DynamicForm
// shows as "required" — on a field that is not, so the update could not be
// sent although nobody touched it. null now reads as no value on an optional
// field, the way #309 reads it for integers. Nothing else changes: "" is
// still what it was, and a required field still refuses null as missing.

const path = "Deployment[web].spec.template.spec.containers[0].env[0].value";

type NonIntegerType = "string" | "autocomplete" | "boolean" | "enum";

function fieldFor(type: NonIntegerType, required: boolean, p = path): UISpecField {
  switch (type) {
    case "string":
      return { path: p, label: "Value", type, required };
    case "autocomplete":
      return { path: p, label: "Value", type, values: ["web", "api"], required };
    case "boolean":
      return { path: p, label: "Value", type, required };
    case "enum":
      return { path: p, label: "Value", type, values: ["a", "b"], required };
  }
}

// The issue DynamicForm turns into "필수 항목입니다." / "This field is required."
function isRequiredIssue(issue: ZodIssue | undefined): boolean {
  return (
    issue?.code === "invalid_type" &&
    (issue.received === "undefined" || issue.received === "null")
  );
}

// What each type accepts and refuses, apart from null and undefined. `""` is
// listed here, not with the empties, because it keeps what it did before: a
// string field takes it as a value, while boolean and enum refuse it as not
// one of theirs (the form never produces "" for either).
const CASES: Record<
  NonIntegerType,
  { valid: unknown[]; invalid: unknown[]; emptyString: "accepted" | "refused" }
> = {
  string: { valid: ["web"], invalid: [5, true, ["web"]], emptyString: "accepted" },
  autocomplete: { valid: ["web", "not-suggested"], invalid: [5, false], emptyString: "accepted" },
  boolean: { valid: [true, false], invalid: ["yes", "false", 0, 1], emptyString: "refused" },
  enum: { valid: ["a", "b"], invalid: ["z", 1, true], emptyString: "refused" },
};

const TYPES = Object.keys(CASES) as NonIntegerType[];

describe("optional non-integer fields, stored null (#316)", () => {
  for (const type of TYPES) {
    describe(type, () => {
      it("reads null on an optional field as no value, like a missing key", () => {
        const schema = schemaFromUISpec({ fields: [fieldFor(type, false)] });
        for (const empty of [null, undefined]) {
          const r = schema.safeParse({ [path]: empty });
          expect(r.success, JSON.stringify(empty)).toBe(true);
          expect(r.data?.[path]).toBeUndefined();
          // The payload leaves the key out, so the backend fills the ui-spec
          // default instead of refusing a null it cannot validate.
          expect(JSON.stringify(r.data)).toBe("{}");
        }
        const missing = schema.safeParse({});
        expect(missing.success).toBe(true);
        expect(JSON.stringify(missing.data)).toBe("{}");
      });

      it("refuses null and undefined on a required field with the required issue", () => {
        const schema = schemaFromUISpec({ fields: [fieldFor(type, true)] });
        for (const empty of [null, undefined]) {
          const r = schema.safeParse({ [path]: empty });
          expect(r.success, JSON.stringify(empty)).toBe(false);
          expect(r.error?.issues).toHaveLength(1);
          expect(isRequiredIssue(r.error?.issues[0]), JSON.stringify(empty)).toBe(true);
          expect(r.error?.issues[0].path).toEqual([path]);
        }
        const missing = schema.safeParse({});
        expect(missing.success).toBe(false);
        expect(isRequiredIssue(missing.error?.issues[0])).toBe(true);
      });

      for (const required of [true, false]) {
        const kind = required ? "required" : "optional";

        it(`${kind}: accepts a valid value unchanged`, () => {
          const schema = schemaFromUISpec({ fields: [fieldFor(type, required)] });
          for (const v of CASES[type].valid) {
            const r = schema.safeParse({ [path]: v });
            expect(r.success, JSON.stringify(v)).toBe(true);
            expect(r.data?.[path]).toBe(v);
          }
        });

        it(`${kind}: refuses an invalid value, and not as missing`, () => {
          const schema = schemaFromUISpec({ fields: [fieldFor(type, required)] });
          for (const v of CASES[type].invalid) {
            const r = schema.safeParse({ [path]: v });
            expect(r.success, JSON.stringify(v)).toBe(false);
            expect(isRequiredIssue(r.error?.issues[0]), JSON.stringify(v)).toBe(false);
          }
        });

        it(`${kind}: treats "" as it always has (${CASES[type].emptyString})`, () => {
          const schema = schemaFromUISpec({ fields: [fieldFor(type, required)] });
          const r = schema.safeParse({ [path]: "" });
          if (CASES[type].emptyString === "accepted") {
            expect(r.success).toBe(true);
            expect(r.data?.[path]).toBe("");
          } else {
            expect(r.success).toBe(false);
            // Not "required": "" is a value, just not one of this field's.
            expect(isRequiredIssue(r.error?.issues[0])).toBe(false);
          }
        });
      }
    });
  }

  // A stored null must not be run through a string's constraints either: it is
  // no value, not a value that fails the pattern or the minimum length.
  it("does not check an optional string's length or pattern against null", () => {
    const spec: UISpec = {
      fields: [{ path, label: "Value", type: "string", minLength: 3, pattern: "^[a-z]+$" }],
    };
    const schema = schemaFromUISpec(spec);
    expect(schema.safeParse({ [path]: null }).success).toBe(true);
    expect(schema.safeParse({ [path]: "ab" }).success).toBe(false);
    expect(schema.safeParse({ [path]: "ABC" }).success).toBe(false);
    expect(schema.safeParse({ [path]: "abc" }).success).toBe(true);
  });

  it("keeps optional nulls from affecting the fields beside them", () => {
    const spec: UISpec = {
      fields: [
        fieldFor("string", false, "s"),
        fieldFor("autocomplete", false, "a"),
        fieldFor("boolean", false, "b"),
        fieldFor("enum", false, "e"),
        { path: "metadata.name", label: "Name", type: "string", required: true },
      ],
    };
    const r = schemaFromUISpec(spec).safeParse({ s: null, a: null, b: null, e: null, "metadata.name": "web" });
    expect(r.success).toBe(true);
    expect(JSON.parse(JSON.stringify(r.data))).toEqual({ "metadata.name": "web" });
  });
});

// #310's Secret rules sit on top: a kept Secret is required whatever the
// ui-spec says, so null is not "no value" for it — sending no value would let
// the backend fill the ui-spec default over the running Secret.
describe("Secrets and stored null (#316 with #288, #196)", () => {
  const secretFields: UISpecField[] = [
    { path: "Secret[app].stringData.PASSWORD", label: "Password", type: "string", default: "changeme" },
    { path: "Secret[app].stringData.HOST", label: "Host", type: "autocomplete", values: ["db"] },
    { path: "Secret[app].stringData.DEBUG", label: "Debug", type: "boolean", default: true },
    { path: "Secret[app].stringData.MODE", label: "Mode", type: "enum", values: ["x", "y"], default: "x" },
  ];
  const spec: UISpec = { fields: secretFields };
  const start: Record<string, unknown> = Object.fromEntries(secretFields.map((f) => [f.path, REDACTED_SECRET]));
  const replacement: Record<string, unknown> = {
    "Secret[app].stringData.PASSWORD": "s3cret",
    "Secret[app].stringData.HOST": "db",
    "Secret[app].stringData.DEBUG": false,
    "Secret[app].stringData.MODE": "y",
  };

  it("still accepts the placeholder for a kept Secret of every type", () => {
    const schema = schemaFromUISpec(spec, { keptSecrets: keptSecretPaths(start) });
    const r = schema.safeParse(start);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(start);
  });

  it("refuses null and undefined for a kept Secret although the ui-spec makes it optional", () => {
    const schema = schemaFromUISpec(spec, { keptSecrets: keptSecretPaths(start) });
    for (const f of secretFields) {
      for (const empty of [null, undefined]) {
        const r = schema.safeParse({ ...start, [f.path]: empty });
        expect(r.success, `${f.type} ${JSON.stringify(empty)}`).toBe(false);
        expect(r.error?.issues[0].path).toEqual([f.path]);
      }
      expect(schema.safeParse({ ...start, [f.path]: replacement[f.path] }).success, f.type).toBe(true);
    }
  });

  it("refuses null for a Secret to enter again", () => {
    const schema = schemaFromUISpec(spec, { reenterSecrets: new Set(secretFields.map((f) => f.path)) });
    for (const f of secretFields) {
      const r = schema.safeParse({ ...replacement, [f.path]: null });
      expect(r.success, f.type).toBe(false);
      expect(isRequiredIssue(r.error?.issues[0]), f.type).toBe(true);
    }
    expect(schema.safeParse(replacement).success).toBe(true);
  });

  it("reads null as no value for an optional Secret field the form did not start redacted", () => {
    const schema = schemaFromUISpec(spec);
    const r = schema.safeParse(Object.fromEntries(secretFields.map((f) => [f.path, null])));
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data)).toBe("{}");
  });
});
