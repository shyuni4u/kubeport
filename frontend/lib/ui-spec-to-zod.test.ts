import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  schemaFromUISpec,
  uiSpecProblems,
  normalizeUISpec,
  defaultsFromUISpec,
  type UISpec,
} from "./ui-spec-to-zod";

describe("schemaFromUISpec", () => {
  describe("integer", () => {
    it("accepts in-range values", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            min: 1,
            max: 10,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.replicas": 3 });
      expect(result.success).toBe(true);
    });

    it("rejects values below min", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            min: 1,
            max: 10,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.replicas": 0 });
      expect(result.success).toBe(false);
    });

    it("rejects values above max", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            min: 1,
            max: 10,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.replicas": 11 });
      expect(result.success).toBe(false);
    });

    it("coerces string inputs to numbers (form inputs)", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            min: 1,
            max: 10,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.replicas": "5" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data["spec.replicas"]).toBe(5);
      }
    });

    it("rejects non-integer decimals", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.replicas": 3.5 });
      expect(result.success).toBe(false);
    });
  });

  describe("string", () => {
    it("accepts plain strings", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "nginx" });
      expect(result.success).toBe(true);
    });

    it("rejects pattern mismatch", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            pattern: "^[a-z]+$",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "ABC123" });
      expect(result.success).toBe(false);
    });

    it("accepts pattern match", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            pattern: "^[a-z]+$",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "nginx" });
      expect(result.success).toBe(true);
    });

    it("rejects strings shorter than minLength", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            minLength: 3,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "ab" });
      expect(result.success).toBe(false);
    });

    it("rejects strings longer than maxLength", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            maxLength: 5,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "abcdef" });
      expect(result.success).toBe(false);
    });

    it("accepts strings within length bounds", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            minLength: 3,
            maxLength: 5,
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "metadata.name": "abcd" });
      expect(result.success).toBe(true);
    });
  });

  describe("boolean", () => {
    it("accepts true", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.enabled",
            label: "Enabled",
            type: "boolean",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.enabled": true });
      expect(result.success).toBe(true);
    });

    it("accepts false", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.enabled",
            label: "Enabled",
            type: "boolean",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.enabled": false });
      expect(result.success).toBe(true);
    });

    it("rejects non-boolean values", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.enabled",
            label: "Enabled",
            type: "boolean",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.enabled": "yes" });
      expect(result.success).toBe(false);
    });
  });

  describe("enum", () => {
    it("accepts listed values", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.type",
            label: "Type",
            type: "enum",
            values: ["ClusterIP", "NodePort", "LoadBalancer"],
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.type": "NodePort" });
      expect(result.success).toBe(true);
    });

    it("rejects values not in the list", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.type",
            label: "Type",
            type: "enum",
            values: ["ClusterIP", "NodePort"],
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ "spec.type": "ExternalName" });
      expect(result.success).toBe(false);
    });

    // Was "throws when enum field has no values" until #164. Throwing looked
    // right while this function's input was a saved template, but its real
    // input is the ui-spec the admin is typing, where `values:` not being
    // written yet is a moment every enum field passes through. The throw ran
    // inside a `useMemo` and took the editor down with the draft in it.
    //
    // The field is left out of the schema instead, and `uiSpecProblems` is
    // what tells the admin it dropped out.
    it("leaves an enum with no values out of the schema", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.type",
            label: "Type",
            type: "enum",
            values: [],
            required: true,
          },
        ],
      };
      expect(() => schemaFromUISpec(spec)).not.toThrow();
      expect(Object.keys(schemaFromUISpec(spec).shape)).toEqual([]);
      expect(uiSpecProblems(spec)).toEqual(["fields[0].values (enum)"]);
    });
  });

  describe("autocomplete", () => {
    it("accepts suggested values", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "image",
            label: "Image",
            type: "autocomplete",
            values: ["nginx:1.25", "nginx:1.27"],
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      expect(schema.safeParse({ image: "nginx:1.27" }).success).toBe(true);
    });

    it("accepts free input outside the suggestions (key difference from enum)", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "image",
            label: "Image",
            type: "autocomplete",
            values: ["nginx:1.25"],
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({ image: "ghcr.io/internal/custom:v9" });
      expect(result.success).toBe(true);
    });

    it("honors pattern when set", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "image",
            label: "Image",
            type: "autocomplete",
            values: ["nginx:1.25"],
            pattern: "^[a-z]",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      expect(schema.safeParse({ image: "Bad-Start" }).success).toBe(false);
      expect(schema.safeParse({ image: "lowercase-start" }).success).toBe(true);
    });

    it("does not throw when autocomplete has empty values (vs enum which throws)", () => {
      // Empty suggestion list is unusual but coherent — admin just hasn't
      // filled it in yet. Renders as a plain text input. Unlike enum which
      // requires at least one value to build a z.enum tuple.
      const spec: UISpec = {
        fields: [
          {
            path: "image",
            label: "Image",
            type: "autocomplete",
            values: [],
          },
        ],
      };
      expect(() => schemaFromUISpec(spec)).not.toThrow();
    });
  });

  describe("required vs optional", () => {
    it("required: true rejects missing key", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("required: false accepts missing key", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            required: false,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("no required property treated as optional", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("optional integer accepts missing key", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe("flat-key convention", () => {
    it("uses dotted path strings as top-level keys (not nested objects)", () => {
      const spec: UISpec = {
        fields: [
          {
            path: "spec.replicas",
            label: "Replicas",
            type: "integer",
            required: true,
          },
          {
            path: "metadata.name",
            label: "Name",
            type: "string",
            required: true,
          },
        ],
      };
      const schema = schemaFromUISpec(spec);
      const result = schema.safeParse({
        "spec.replicas": 3,
        "metadata.name": "nginx",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty("spec.replicas", 3);
        expect(result.data).toHaveProperty("metadata.name", "nginx");
      }
    });
  });
});

describe("defaultsFromUISpec", () => {
  it("returns empty object when no field has a default", () => {
    const spec: UISpec = {
      fields: [
        { path: "metadata.name", label: "Name", type: "string" },
        { path: "spec.replicas", label: "Replicas", type: "integer" },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({});
  });

  it("includes only fields with default !== undefined", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
        },
        { path: "spec.replicas", label: "Replicas", type: "integer" },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({ "metadata.name": "nginx" });
  });

  it("handles string defaults", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
        },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({ "metadata.name": "nginx" });
  });

  it("handles integer defaults including 0", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.replicas",
          label: "Replicas",
          type: "integer",
          default: 0,
        },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({ "spec.replicas": 0 });
  });

  it("handles boolean defaults including false", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.enabled",
          label: "Enabled",
          type: "boolean",
          default: false,
        },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({ "spec.enabled": false });
  });

  it("handles enum defaults", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.type",
          label: "Type",
          type: "enum",
          values: ["ClusterIP", "NodePort"],
          default: "ClusterIP",
        },
      ],
    };
    expect(defaultsFromUISpec(spec)).toEqual({ "spec.type": "ClusterIP" });
  });

  it("returns a Record<string, unknown> keyed by flat path", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
        },
        {
          path: "spec.replicas",
          label: "Replicas",
          type: "integer",
          default: 3,
        },
      ],
    };
    const result = defaultsFromUISpec(spec);
    expect(result).toEqual({
      "metadata.name": "nginx",
      "spec.replicas": 3,
    });
  });
});

// #164 — the ui-spec these functions receive comes from YAML the admin is
// still typing, so its runtime shape is not the union the type claims. Both
// throws that used to live here ran inside a `useMemo`, so they took out the
// whole editor page and the unsaved draft with it.
//
// The specs below are cast because that is exactly the situation being
// tested: values TypeScript says cannot exist, arriving anyway.
describe("schemaFromUISpec on a half-typed spec", () => {
  it("skips a field whose type is not a known one, instead of throwing", () => {
    const spec = {
      fields: [
        { path: "a", label: "A", type: "sxtring" },
        { path: "b", label: "B", type: "string" },
      ],
    } as unknown as UISpec;

    const schema = schemaFromUISpec(spec);
    // The good field still validates; the unknown one is simply absent.
    expect(schema.safeParse({ b: "ok" }).success).toBe(true);
    expect(Object.keys(schema.shape)).toEqual(["b"]);
  });

  it("skips a field whose type is missing entirely", () => {
    const spec = { fields: [{ path: "a", label: "A" }] } as unknown as UISpec;
    expect(() => schemaFromUISpec(spec)).not.toThrow();
    expect(Object.keys(schemaFromUISpec(spec).shape)).toEqual([]);
  });

  // `enum:` written, `values:` not yet — the other throw.
  it("skips an enum with no values yet", () => {
    const spec = {
      fields: [{ path: "a", label: "A", type: "enum", values: [] }],
    } as unknown as UISpec;
    expect(() => schemaFromUISpec(spec)).not.toThrow();
    expect(Object.keys(schemaFromUISpec(spec).shape)).toEqual([]);
  });

  it("skips an enum whose values is not a list", () => {
    const spec = {
      fields: [{ path: "a", label: "A", type: "enum", values: "nope" }],
    } as unknown as UISpec;
    expect(() => schemaFromUISpec(spec)).not.toThrow();
  });
});

describe("uiSpecProblems", () => {
  it("names the field and what is wrong with it", () => {
    const spec = {
      fields: [
        { path: "a", label: "A", type: "string" },
        { path: "b", label: "B", type: "sxtring" },
        { path: "c", label: "C", type: "enum", values: [] },
      ],
    } as unknown as UISpec;

    expect(uiSpecProblems(spec)).toEqual([
      'fields[1].type: "sxtring"',
      "fields[2].values (enum)",
    ]);
  });

  it("is empty for a spec that builds cleanly", () => {
    const spec: UISpec = {
      fields: [
        { path: "a", label: "A", type: "string" },
        { path: "b", label: "B", type: "enum", values: ["x"] },
      ],
    };
    expect(uiSpecProblems(spec)).toEqual([]);
  });

  // The note the admin reads and the fields that actually dropped out have to
  // be the same set, or the note sends them looking at the wrong line.
  it("agrees with the schema builder about which fields drop out", () => {
    const spec = {
      fields: [
        { path: "keep", label: "K", type: "boolean" },
        { path: "drop", label: "D", type: "wat" },
      ],
    } as unknown as UISpec;
    expect(uiSpecProblems(spec)).toHaveLength(1);
    expect(Object.keys(schemaFromUISpec(spec).shape)).toEqual(["keep"]);
  });
});

// The trust boundary. Everything downstream is allowed to believe the UISpec
// type only because this ran first, so what it lets through is the contract.
describe("normalizeUISpec", () => {
  it("drops a field with an unknown type and reports it", () => {
    const raw = {
      fields: [
        { path: "a", label: "A", type: "string" },
        { path: "b", label: "B", type: "sxtring" },
      ],
    } as unknown as UISpec;
    const { spec, problems } = normalizeUISpec(raw);
    expect(spec.fields.map((f) => f.path)).toEqual(["a"]);
    expect(problems).toEqual(['fields[1].type: "sxtring"']);
  });

  // An enum with no values reaches the widget renderer, not just the schema
  // builder — `renderWidget` reads `values.length` off it.
  it("drops an enum with no values", () => {
    const raw = {
      fields: [{ path: "a", label: "A", type: "enum" }],
    } as unknown as UISpec;
    expect(normalizeUISpec(raw).spec.fields).toEqual([]);
  });

  // A lone "[" is on the way to every character class ever written. Costing
  // the field would make it blink out of the preview mid-keystroke, so it
  // costs the pattern instead and the row stays put.
  it("keeps a field whose pattern does not compile, minus the pattern", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: "[" }],
    };
    const { spec, problems } = normalizeUISpec(raw);
    expect(spec.fields).toHaveLength(1);
    expect((spec.fields[0] as { pattern?: string }).pattern).toBeUndefined();
    expect(problems).toEqual(["fields[0].pattern"]);
    expect(() => schemaFromUISpec(spec)).not.toThrow();
  });

  it("leaves a pattern that compiles alone", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: "^[a-z]+$" }],
    };
    const { spec, problems } = normalizeUISpec(raw);
    expect((spec.fields[0] as { pattern?: string }).pattern).toBe("^[a-z]+$");
    expect(problems).toEqual([]);
    const schema = schemaFromUISpec(spec);
    expect(schema.safeParse({ a: "abc" }).success).toBe(true);
    expect(schema.safeParse({ a: "ABC" }).success).toBe(false);
  });

  // #189: `\A` compiles here too, but as a literal "A" — so the form enforced
  // a rule the API does not have. The API now refuses it on save; the preview
  // says so first rather than running the wrong rule.
  it("sets aside a pattern Go and the browser read differently", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: String.raw`\Aabc` }],
    };
    const { spec, problems, ignored, refused } = normalizeUISpec(raw);
    expect((spec.fields[0] as { pattern?: string }).pattern).toBeUndefined();
    expect(problems).toEqual(["fields[0].pattern"]);
    // Finished, not mid-keystroke: the preview must not say "until complete".
    expect(refused).toEqual(["fields[0].pattern"]);
    expect(ignored).toEqual([]);
  });

  it("still calls an unfinished pattern ignored, not refused", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: "^[a-z" }],
    };
    const { ignored, refused } = normalizeUISpec(raw);
    expect(ignored).toEqual(["fields[0].pattern"]);
    expect(refused).toEqual([]);
  });

  // #187: this compiles, and the form runs it on every keystroke.
  it("sets aside a pattern that can backtrack catastrophically", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "autocomplete", values: [], pattern: "^(a+)+$" }],
    };
    const { spec, problems } = normalizeUISpec(raw);
    expect((spec.fields[0] as { pattern?: string }).pattern).toBeUndefined();
    expect(problems).toEqual(["fields[0].pattern"]);
    // Defence in depth for a caller that skips normalizeUISpec. The value does
    // not match `^(a+)+$`, so success proves the pattern was never applied; had
    // it been, this call would backtrack for longer than vitest's timeout. No
    // wall-clock budget: those flake on a loaded runner (#297).
    expect(schemaFromUISpec(raw).safeParse({ a: "a".repeat(40) + "!" }).success).toBe(true);
  });

  it("sets aside a pattern longer than 200 characters", () => {
    const raw: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: "a".repeat(201) }],
    };
    expect(normalizeUISpec(raw).problems).toEqual(["fields[0].pattern"]);
  });

  // zod runs every check, so `.max()` does not keep a long value away from
  // the pattern. The bound has to sit in front of the pattern itself.
  it("does not run the pattern on a value longer than the input bound", () => {
    const spec: UISpec = {
      fields: [{ path: "a", label: "A", type: "string", pattern: "^[a-z]+$", maxLength: 10 }],
    };
    const schema = schemaFromUISpec(spec);
    const issues = (v: string) => {
      const r = schema.safeParse({ a: v });
      return r.success ? [] : r.error.issues.map((i) => i.code);
    };
    // Within the bound the pattern still reports, with the code DynamicForm
    // turns into its "not an allowed format" message.
    expect(issues("A".repeat(256))).toEqual(["too_big", "invalid_string"]);
    // Past it only the length check reports; the API still checks the pattern.
    expect(issues("A".repeat(257))).toEqual(["too_big"]);
  });

  // Without the `u` flag the browser reads "😀" as two halves, while the API
  // reads one character. A value holding such characters is checked the way
  // the API reads it, or left to the API.
  it("checks a value with characters outside the BMP the way the API reads it", () => {
    const check = (pattern: string, value: string) =>
      schemaFromUISpec({ fields: [{ path: "a", label: "A", type: "string", pattern }] }).safeParse({ a: value })
        .success;
    expect(check("^[^a]{2}$", "😀")).toBe(false); // flagless, the two halves would match
    expect(check("^.{2}$", "😀😀")).toBe(true); // flagless, the four halves would not
    expect(check("^.$", "\uD83D")).toBe(true); // a lone half reaches the API as U+FFFD
    expect(check("^\\_$", "😀")).toBe(true); // no Unicode-mode reading: left to the API
    expect(check("^\\_$", "_")).toBe(true);
    expect(check("^\\_$", "a")).toBe(false);
  });

  // The live demo reseeds from these files daily. A rule that sets their
  // patterns aside would leave the demo's deploy form without them.
  it("keeps every pattern in the demo seed fixtures", () => {
    const dir = path.resolve(__dirname, "../../backend/cmd/seed-demo/fixtures");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ui-spec.yaml"));
    expect(files.length).toBeGreaterThan(0);
    let seen = 0;
    for (const file of files) {
      const spec = parseYaml(readFileSync(path.join(dir, file), "utf8")) as UISpec;
      const { problems, spec: normalized } = normalizeUISpec(spec);
      expect(problems, file).toEqual([]);
      spec.fields.forEach((f, i) => {
        if ("pattern" in f && f.pattern) {
          seen++;
          expect((normalized.fields[i] as { pattern?: string }).pattern, file).toBe(f.pattern);
        }
      });
    }
    expect(seen).toBeGreaterThan(0);
  });

  // `values` is advisory for autocomplete, but the renderer spreads it into a
  // Set — undefined would throw there rather than in the schema.
  it("gives autocomplete an empty values list rather than undefined", () => {
    const raw = {
      fields: [{ path: "a", label: "A", type: "autocomplete" }],
    } as unknown as UISpec;
    const { spec, problems } = normalizeUISpec(raw);
    expect(spec.fields).toHaveLength(1);
    expect((spec.fields[0] as { values?: string[] }).values).toEqual([]);
    expect(problems).toEqual(["fields[0].values (autocomplete)"]);
  });

  it("passes a clean spec through unchanged", () => {
    const raw: UISpec = {
      fields: [
        { path: "a", label: "A", type: "string" },
        { path: "b", label: "B", type: "enum", values: ["x", "y"] },
      ],
    };
    const { spec, problems } = normalizeUISpec(raw);
    expect(spec.fields).toEqual(raw.fields);
    expect(problems).toEqual([]);
  });
});
