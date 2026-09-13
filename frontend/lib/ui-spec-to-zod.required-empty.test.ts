import { describe, it, expect } from "vitest";
import type { ZodIssue } from "zod";
import { REDACTED_SECRET, schemaFromUISpec, type UISpecField } from "./ui-spec-to-zod";

// #331: a required string or autocomplete field was a bare z.string(). A new
// form starts it as undefined, which is refused, but a text box that has been
// typed in and emptied holds "", which parsed — so the deploy form previewed
// and checked permissions for a required field nobody had filled.
//
// "" is now missing on a required text field. Nothing else is:
// - "   " is still a value. The API's `required` is a presence check and a
//   string field takes any string (backend template/empty_string_test.go);
//   the form does not refuse what the API accepts.
// - an optional field takes "" as "", exactly as before. The API writes it
//   over the ui-spec default (same test file), which is out of scope here.
// - a minLength of 1 or more already refuses "" with its own message, which
//   stays the one shown.

const path = "ConfigMap[app].data.API_KEY";
type TextType = "string" | "autocomplete";

function fieldFor(type: TextType, required: boolean, extra: Partial<UISpecField> = {}): UISpecField {
  const base =
    type === "string"
      ? { path, label: "API 키", type, required }
      : { path, label: "API 키", type, values: ["one", "two"], required };
  return { ...base, ...extra } as UISpecField;
}

function parse(field: UISpecField, value: unknown) {
  return schemaFromUISpec({ fields: [field] }).safeParse({ [path]: value });
}

function firstIssue(field: UISpecField, value: unknown): ZodIssue | undefined {
  const r = parse(field, value);
  return r.success ? undefined : r.error.issues[0];
}

// What DynamicForm's resolver turns into "필수 항목입니다.": invalid_type for
// undefined/null, or a string too_small whose minimum is 1.
function isRequiredIssue(issue: ZodIssue | undefined): boolean {
  if (!issue) return false;
  if (issue.code === "invalid_type") return issue.received === "undefined" || issue.received === "null";
  return issue.code === "too_small" && issue.type === "string" && Number(issue.minimum) <= 1;
}

for (const type of ["string", "autocomplete"] as const) {
  describe(`required ${type} (#331)`, () => {
    it('refuses "" with the required issue, as it refuses no value', () => {
      const field = fieldFor(type, true);
      for (const empty of [undefined, null, ""]) {
        const r = parse(field, empty);
        expect(r.success, JSON.stringify(empty)).toBe(false);
        expect(r.error?.issues, JSON.stringify(empty)).toHaveLength(1);
        expect(isRequiredIssue(r.error?.issues[0]), JSON.stringify(empty)).toBe(true);
        expect(r.error?.issues[0].path).toEqual([path]);
      }
    });

    it("accepts a value, and a blank one the API accepts too", () => {
      const field = fieldFor(type, true);
      for (const v of ["a", "   "]) {
        const r = parse(field, v);
        expect(r.success, JSON.stringify(v)).toBe(true);
        expect(r.data?.[path]).toBe(v);
      }
    });

    it('keeps minLength\'s own message for "" when minLength already refuses it', () => {
      const issue = firstIssue(fieldFor(type, true, { minLength: 3 }), "");
      expect(issue?.code).toBe("too_small");
      expect(issue && "minimum" in issue ? Number(issue.minimum) : undefined).toBe(3);
      expect(isRequiredIssue(issue)).toBe(false);

      // minLength 1 was already read as "required".
      expect(isRequiredIssue(firstIssue(fieldFor(type, true, { minLength: 1 }), ""))).toBe(true);
      expect(parse(fieldFor(type, true, { minLength: 3 }), "ab").success).toBe(false);
      expect(parse(fieldFor(type, true, { minLength: 3 }), "abc").success).toBe(true);
    });

    it('says "required" for "" under a maxLength or a pattern, and keeps their own issues for values', () => {
      const withMax = fieldFor(type, true, { maxLength: 5 });
      expect(isRequiredIssue(firstIssue(withMax, ""))).toBe(true);
      const tooLong = firstIssue(withMax, "abcdef");
      expect(tooLong?.code).toBe("too_big");

      const withPattern = fieldFor(type, true, { pattern: "^[a-z]+$" });
      expect(isRequiredIssue(firstIssue(withPattern, ""))).toBe(true);
      const mismatch = firstIssue(withPattern, "ABC");
      expect(mismatch?.code).toBe("invalid_string");
      expect(mismatch && "validation" in mismatch ? mismatch.validation : undefined).toBe("regex");
      expect(parse(withPattern, "abc").success).toBe(true);
      // The API refuses a blank value against this pattern as well.
      expect(firstIssue(withPattern, "   ")?.code).toBe("invalid_string");
    });
  });

  describe(`optional ${type}, "" as before (#331)`, () => {
    it('takes "" as "", and no value as no key', () => {
      const field = fieldFor(type, false);
      const empty = parse(field, "");
      expect(empty.success).toBe(true);
      expect(empty.data?.[path]).toBe("");
      expect(JSON.stringify(empty.data)).toBe(JSON.stringify({ [path]: "" }));

      for (const v of ["a", "   "]) {
        expect(parse(field, v).data?.[path]).toBe(v);
      }
      for (const none of [undefined, null]) {
        const r = parse(field, none);
        expect(r.success).toBe(true);
        expect(JSON.stringify(r.data)).toBe("{}");
      }
    });

    it("still runs minLength and pattern against an optional \"\"", () => {
      expect(firstIssue(fieldFor(type, false, { minLength: 3 }), "")?.code).toBe("too_small");
      expect(firstIssue(fieldFor(type, false, { pattern: "^[a-z]+$" }), "")?.code).toBe("invalid_string");
    });
  });
}

describe("Secret strings are unchanged by #331", () => {
  const secret = "Secret[app].stringData.PASSWORD";
  const field: UISpecField = { path: secret, label: "Password", type: "string", minLength: 3 };

  it('refuses "" as required for a kept Secret, even with a minLength', () => {
    const schema = schemaFromUISpec({ fields: [field] }, { keptSecrets: new Set([secret]) });
    expect(schema.safeParse({ [secret]: REDACTED_SECRET }).success).toBe(true);
    const r = schema.safeParse({ [secret]: "" });
    expect(r.success).toBe(false);
    const union = r.error?.issues[0];
    const own = union?.code === "invalid_union" ? union.unionErrors.at(-1)?.issues[0] : union;
    expect(isRequiredIssue(own)).toBe(true);
  });

  it('refuses "" as required for a Secret to enter again, even with a minLength', () => {
    const schema = schemaFromUISpec({ fields: [field] }, { reenterSecrets: new Set([secret]) });
    expect(isRequiredIssue(schema.safeParse({ [secret]: "" }).error?.issues[0])).toBe(true);
    expect(schema.safeParse({ [secret]: "s3cret" }).success).toBe(true);
  });
});
