import { describe, it, expect } from "vitest";
import type { ZodIssue } from "zod";
import { schemaFromUISpec, type UISpec, type UISpecField } from "./ui-spec-to-zod";

// #309: integer fields used `z.coerce.number()`, which is `Number(v)`, so null
// and "" (and false, []) passed as 0. A release whose stored values held null
// for an integer came back into the update form and went out as 0 — a value
// nobody picked. Empty now means missing, the same as a key that is not there.

const path = "Deployment[web].spec.replicas";

type Bounds = { min?: number; max?: number };
const BOUNDS: Array<[string, Bounds]> = [
  ["no bounds", {}],
  ["min only", { min: 0 }],
  ["max only", { max: 5 }],
  ["min and max (slider)", { min: 0, max: 5 }],
];

function specFor(required: boolean, bounds: Bounds): UISpec {
  const field: UISpecField = { path, label: "Replicas", type: "integer", required, ...bounds };
  return { fields: [field] };
}

const EMPTY: unknown[] = [null, "", "   ", undefined];

// The issue DynamicForm turns into "필수 항목입니다." / "This field is required."
function isRequiredIssue(issue: ZodIssue | undefined): boolean {
  return (
    issue?.code === "invalid_type" &&
    (issue.received === "undefined" || issue.received === "null")
  );
}

describe("integer field, empty values (#309)", () => {
  for (const [name, bounds] of BOUNDS) {
    describe(name, () => {
      it("refuses empty on a required field with the required issue", () => {
        const schema = schemaFromUISpec(specFor(true, bounds));
        for (const empty of EMPTY) {
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

      it("reads empty on an optional field as no value, like a missing key", () => {
        const schema = schemaFromUISpec(specFor(false, bounds));
        for (const empty of EMPTY) {
          const r = schema.safeParse({ [path]: empty });
          expect(r.success, JSON.stringify(empty)).toBe(true);
          expect(r.data?.[path]).toBeUndefined();
          // The payload leaves the key out, so the backend fills the ui-spec
          // default instead of receiving a 0 or a null.
          expect(JSON.stringify(r.data)).toBe("{}");
        }
        const missing = schema.safeParse({});
        expect(missing.success).toBe(true);
        expect(JSON.stringify(missing.data)).toBe("{}");
      });

      for (const required of [true, false]) {
        const kind = required ? "required" : "optional";

        it(`${kind}: accepts 0 and numeric strings, as before`, () => {
          const schema = schemaFromUISpec(specFor(required, bounds));
          const zero = schema.safeParse({ [path]: 0 });
          expect(zero.success).toBe(true);
          expect(zero.data?.[path]).toBe(0);
          const three = schema.safeParse({ [path]: "3" });
          expect(three.success).toBe(true);
          expect(three.data?.[path]).toBe(3);
          expect(schema.safeParse({ [path]: " 4 " }).data?.[path]).toBe(4);
        });

        it(`${kind}: still refuses what is not an integer`, () => {
          const schema = schemaFromUISpec(specFor(required, bounds));
          for (const bad of ["abc", 1.5, "1.5", NaN]) {
            const r = schema.safeParse({ [path]: bad });
            expect(r.success, String(bad)).toBe(false);
            expect(isRequiredIssue(r.error?.issues[0]), String(bad)).toBe(false);
          }
        });

        // Number(false) and Number([]) are 0 too: the same value nobody picked.
        it(`${kind}: refuses a boolean, array or object instead of reading it as a number`, () => {
          const schema = schemaFromUISpec(specFor(required, bounds));
          for (const bad of [false, true, [], [3], {}]) {
            const r = schema.safeParse({ [path]: bad });
            expect(r.success, JSON.stringify(bad)).toBe(false);
            expect(r.error?.issues[0].code).toBe("invalid_type");
            expect(isRequiredIssue(r.error?.issues[0])).toBe(false);
          }
        });
      }
    });
  }

  it("keeps the min/max issues it has always given", () => {
    const schema = schemaFromUISpec(specFor(false, { min: 1, max: 10 }));
    const low = schema.safeParse({ [path]: 0 });
    expect(low.error?.issues[0]).toMatchObject({ code: "too_small", type: "number", minimum: 1 });
    const lowString = schema.safeParse({ [path]: "0" });
    expect(lowString.error?.issues[0]).toMatchObject({ code: "too_small", type: "number", minimum: 1 });
    const high = schema.safeParse({ [path]: 11 });
    expect(high.error?.issues[0]).toMatchObject({ code: "too_big", type: "number", maximum: 10 });
    expect(schema.safeParse({ [path]: 10 }).data?.[path]).toBe(10);
  });

  it("still coerces a large port-like string", () => {
    const schema = schemaFromUISpec(specFor(true, {}));
    expect(schema.safeParse({ [path]: "8080" }).data?.[path]).toBe(8080);
  });

  it("keeps an optional empty integer from affecting the fields beside it", () => {
    const spec: UISpec = {
      fields: [
        { path, label: "Replicas", type: "integer" },
        { path: "metadata.name", label: "Name", type: "string", required: true },
      ],
    };
    const r = schemaFromUISpec(spec).safeParse({ [path]: null, "metadata.name": "web" });
    expect(r.success).toBe(true);
    expect(JSON.parse(JSON.stringify(r.data))).toEqual({ "metadata.name": "web" });
  });
});
