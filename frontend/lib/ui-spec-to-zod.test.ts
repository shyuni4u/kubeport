import { describe, it, expect } from "vitest";
import {
  schemaFromUISpec,
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

    it("throws when enum field has no values", () => {
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
      expect(() => schemaFromUISpec(spec)).toThrow(/enum/i);
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
