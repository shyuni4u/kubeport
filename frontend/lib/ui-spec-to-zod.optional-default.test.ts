import { describe, it, expect } from "vitest";
import {
  REDACTED_SECRET,
  emptyTakesDefault,
  schemaFromUISpec,
  type UISpecField,
} from "./ui-spec-to-zod";

// #334: an optional string or autocomplete box typed in and then emptied holds
// "", and the API writes a present "" over the ui-spec default where an omitted
// key takes the default (backend template/empty_string_test.go). Clearing the
// box is how someone says "no value", so for a field that has a default, ""
// now leaves the key out and the API fills the default. Submit and the deploy
// form's preview both read through this schema (#322), so both omit it.
//
// Nothing else changes:
// - an optional field with no default still sends "" as "";
// - "   " is a value (the API takes it; #331), sent as it is;
// - a required field still refuses "" as missing (#331);
// - kept and re-entered Secrets are required, so they refuse "" whatever
//   their default — omitting would put the default over the running Secret.

const path = "Deployment[web].spec.template.spec.containers[0].image";
type TextType = "string" | "autocomplete";

function fieldFor(type: TextType, extra: Partial<UISpecField> = {}): UISpecField {
  const base =
    type === "string"
      ? { path, label: "Image", type }
      : { path, label: "Image", type, values: ["nginx:1.25", "nginx:1.27"] };
  return { ...base, ...extra } as UISpecField;
}

function parse(field: UISpecField, value: unknown, opts?: Parameters<typeof schemaFromUISpec>[1]) {
  return schemaFromUISpec({ fields: [field] }, opts).safeParse({ [path]: value });
}

/** The payload as it goes on the wire: JSON drops a key whose value is undefined. */
function wire(r: ReturnType<typeof parse>): string {
  return JSON.stringify(r.success ? r.data : null);
}

for (const type of ["string", "autocomplete"] as const) {
  describe(`optional ${type} with a default (#334)`, () => {
    const field = fieldFor(type, { default: "nginx:1.25" });

    it('leaves "" out, so the API fills the default', () => {
      const r = parse(field, "");
      expect(r.success).toBe(true);
      expect(r.data?.[path]).toBeUndefined();
      expect(wire(r)).toBe("{}");
    });

    it('sends "   " and a value as they are', () => {
      for (const v of ["   ", "a"]) {
        const r = parse(field, v);
        expect(r.success, JSON.stringify(v)).toBe(true);
        expect(wire(r)).toBe(JSON.stringify({ [path]: v }));
      }
    });

    it("still reads null and no value as no key (#316)", () => {
      for (const none of [undefined, null]) {
        expect(wire(parse(field, none))).toBe("{}");
      }
      expect(JSON.stringify(schemaFromUISpec({ fields: [field] }).safeParse({}).data)).toBe("{}");
    });

    it('does not run minLength or the pattern against "", which is no value now', () => {
      const constrained = fieldFor(type, { default: "nginx", minLength: 3, pattern: "^[a-z]+$" });
      expect(wire(parse(constrained, ""))).toBe("{}");
      expect(parse(constrained, "ab").success).toBe(false);
      expect(parse(constrained, "ABC").success).toBe(false);
      expect(parse(constrained, "   ").success).toBe(false);
      expect(wire(parse(constrained, "abc"))).toBe(JSON.stringify({ [path]: "abc" }));
    });

    it('omits "" for a default of "" too, which renders the same', () => {
      expect(wire(parse(fieldFor(type, { default: "" }), ""))).toBe("{}");
    });

    it("is what emptyTakesDefault says", () => {
      expect(emptyTakesDefault(field)).toBe(true);
    });
  });

  describe(`${type} fields #334 leaves alone`, () => {
    it('optional with no default: "" is still sent as ""', () => {
      const field = fieldFor(type);
      expect(emptyTakesDefault(field)).toBe(false);
      for (const v of ["", "   ", "a"]) {
        expect(wire(parse(field, v)), JSON.stringify(v)).toBe(JSON.stringify({ [path]: v }));
      }
    });

    it('required with a default: "" is refused as missing, a value passes', () => {
      const field = fieldFor(type, { default: "nginx:1.25", required: true });
      expect(emptyTakesDefault(field)).toBe(false);
      const r = parse(field, "");
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]).toMatchObject({ code: "too_small", type: "string", minimum: 1 });
      for (const v of ["   ", "a"]) {
        expect(wire(parse(field, v)), JSON.stringify(v)).toBe(JSON.stringify({ [path]: v }));
      }
    });
  });
}

describe("Secrets with a default are unchanged by #334", () => {
  const secret = "Secret[app].stringData.PASSWORD";
  const secretField = (type: TextType): UISpecField =>
    ({ ...fieldFor(type, { default: "changeme" }), path: secret }) as UISpecField;
  const parseSecret = (type: TextType, value: unknown, opts: Parameters<typeof schemaFromUISpec>[1]) =>
    schemaFromUISpec({ fields: [secretField(type)] }, opts).safeParse({ [secret]: value });

  for (const type of ["string", "autocomplete"] as const) {
    it(`${type}: a kept Secret passes the placeholder and refuses "", never omitting it`, () => {
      const opts = { keptSecrets: new Set([secret]) };
      const kept = parseSecret(type, REDACTED_SECRET, opts);
      expect(JSON.stringify(kept.data)).toBe(JSON.stringify({ [secret]: REDACTED_SECRET }));
      expect(parseSecret(type, "", opts).success).toBe(false);
      for (const v of ["   ", "a"]) {
        expect(JSON.stringify(parseSecret(type, v, opts).data)).toBe(JSON.stringify({ [secret]: v }));
      }
    });

    it(`${type}: a Secret to enter again refuses "", never omitting it`, () => {
      const opts = { reenterSecrets: new Set([secret]) };
      expect(parseSecret(type, "", opts).success).toBe(false);
      expect(JSON.stringify(parseSecret(type, "a", opts).data)).toBe(JSON.stringify({ [secret]: "a" }));
    });

    // Neither kept nor re-entered: a new deploy, or an update whose release
    // stored no value for it. There is no running Secret for the default to
    // replace, so it is an optional field like any other.
    it(`${type}: an optional Secret field with nothing kept takes the default when emptied`, () => {
      expect(JSON.stringify(parseSecret(type, "", {}).data)).toBe("{}");
    });
  }
});
