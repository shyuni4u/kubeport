import { describe, expect, it } from "vitest";

import type { SchemaNode } from "./openapi";
import {
  resourceKinds,
  validateTemplateYaml,
  type SchemaLookup,
  type YamlIssue,
} from "./yaml-validation";

// The starter the /templates/new?mode=yaml page opens with.
const RESOURCES = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: app
          image: nginx:1.25
          ports: [{ containerPort: 80 }]
`;

const UISPEC = `fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
`;

// Enough of apps/v1 Deployment to type-check the starter.
const DEPLOYMENT: SchemaNode = {
  type: "object",
  properties: {
    apiVersion: { type: "string" },
    kind: { type: "string" },
    metadata: { type: "object", properties: { name: { type: "string" } } },
    spec: {
      type: "object",
      properties: {
        replicas: { type: "integer" },
        paused: { type: "boolean" },
        selector: { type: "object" },
        template: {
          type: "object",
          properties: {
            spec: {
              type: "object",
              properties: {
                containers: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      image: { type: "string" },
                      ports: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { containerPort: { type: "integer" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const lookup: SchemaLookup = (apiVersion, kind) =>
  apiVersion === "apps/v1" && kind === "Deployment" ? DEPLOYMENT : undefined;

const codes = (issues: YamlIssue[]) => issues.map((i) => i.code);
const errorsOf = (issues: YamlIssue[]) => issues.filter((i) => i.severity === "error");

describe("validateTemplateYaml", () => {
  it("finds nothing wrong with the starter template", () => {
    const r = validateTemplateYaml(RESOURCES, UISPEC, lookup);
    expect(r.resources).toEqual([]);
    expect(r.uiSpec).toEqual([]);
  });

  it("treats two empty files as valid", () => {
    const r = validateTemplateYaml("", "", lookup);
    expect(r.resources).toEqual([]);
    expect(r.uiSpec).toEqual([]);
  });

  describe("(a) syntax", () => {
    it("reports an unclosed flow sequence as an error on its line", () => {
      const broken = RESOURCES.replace("replicas: 1", "replicas: [1, 2");
      const r = validateTemplateYaml(broken, UISPEC, lookup);
      const errs = errorsOf(r.resources);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0].code).toBe("syntax");
      // Where the parser finds out: the line after the unclosed `[`, whose
      // message names the missing `]`. Not the end of the file.
      expect(errs[0].startLine).toBe(6);
      expect(errs[0].params.detail).toMatch(/\]/);
      expect(errs[0].startCol).toBeGreaterThan(0);
      expect(errs[0].endLine).toBeGreaterThanOrEqual(errs[0].startLine);
    });

    it("reports a syntax error in ui-spec.yaml against that file", () => {
      const r = validateTemplateYaml(RESOURCES, "fields:\n  - path: [\n", lookup);
      expect(codes(errorsOf(r.uiSpec))).toContain("syntax");
      expect(r.resources).toEqual([]);
    });

    it("reports a syntax error in the second document of a multi-document file", () => {
      const multi = `${RESOURCES}---\napiVersion: v1\nkind: Service\nmetadata: { name: web\n`;
      const r = validateTemplateYaml(multi, UISPEC, lookup);
      const errs = errorsOf(r.resources);
      expect(codes(errs)).toContain("syntax");
      // Past the separator — the first document is fine.
      expect(errs[0].startLine).toBeGreaterThan(14);
    });

    it("refuses a document that is not a mapping, as the backend does", () => {
      const r = validateTemplateYaml("- a\n- b\n", "", lookup);
      expect(codes(errorsOf(r.resources))).toEqual(["documentNotMapping"]);
    });

    it("does not throw on an alias bomb", () => {
      const levels = ["a: &a [x, x, x, x, x, x, x, x, x]"];
      for (let i = 1; i < 9; i++) {
        const prev = String.fromCharCode(96 + i);
        const cur = String.fromCharCode(97 + i);
        levels.push(`${cur}: &${cur} [${Array(9).fill(`*${prev}`).join(", ")}]`);
      }
      const bomb = `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n${levels.join("\n")}\n`;
      expect(() => validateTemplateYaml(bomb, "fields:\n  - path: ConfigMap[x].data.k\n    label: K\n    type: string\n", lookup)).not.toThrow();
    });

    it("accepts empty documents between separators", () => {
      const r = validateTemplateYaml(`---\n# only a comment\n---\n${RESOURCES}`, UISPEC, lookup);
      expect(r.resources).toEqual([]);
      expect(r.uiSpec).toEqual([]);
    });
  });

  describe("(b) ui-spec paths", () => {
    it("warns, on the path line, when the named resource was renamed away", () => {
      const renamed = RESOURCES.replace("metadata: { name: web }", "metadata: { name: api }");
      const r = validateTemplateYaml(renamed, UISPEC, lookup);
      expect(r.resources).toEqual([]);
      expect(r.uiSpec).toHaveLength(1);
      const [w] = r.uiSpec;
      expect(w.severity).toBe("warning");
      expect(w.code).toBe("resourceNotFound");
      expect(w.params).toMatchObject({ kind: "Deployment", selector: "web" });
      expect(w.startLine).toBe(2);
    });

    it("resolves a selector-less path when exactly one document has the kind", () => {
      const spec = UISPEC.replace("Deployment[web]", "Deployment");
      expect(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec).toEqual([]);
    });

    it("resolves an index selector, and warns when it is out of range", () => {
      expect(validateTemplateYaml(RESOURCES, UISPEC.replace("[web]", "[0]"), lookup).uiSpec).toEqual([]);
      expect(codes(validateTemplateYaml(RESOURCES, UISPEC.replace("[web]", "[1]"), lookup).uiSpec)).toEqual([
        "resourceNotFound",
      ]);
    });

    it("warns when a selector-less path is ambiguous across documents", () => {
      const two = `${RESOURCES}---\n${RESOURCES.replace("name: web }", "name: api }")}`;
      const spec = UISPEC.replace("Deployment[web]", "Deployment");
      expect(codes(validateTemplateYaml(two, spec, lookup).uiSpec)).toEqual(["resourceAmbiguous"]);
    });

    it("finds the named document in a multi-document file", () => {
      const svc = "apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec:\n  ports: [{ port: 80 }]\n";
      const multi = `${svc}---\n${RESOURCES}`;
      const spec = `${UISPEC}  - path: Service[web].spec.ports[0].port\n    label: Port\n    type: integer\n`;
      expect(validateTemplateYaml(multi, spec, lookup).uiSpec).toEqual([]);
    });

    it("does not warn for a missing leaf key — render creates it", () => {
      const spec = UISPEC.replace("spec.replicas", "spec.minReadySeconds");
      expect(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec).toEqual([]);
    });

    it("warns when the path indexes past the end of a list", () => {
      const spec = UISPEC.replace("spec.replicas", "spec.template.spec.containers[3].image");
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(codes(r.uiSpec)).toEqual(["pathIndexOutOfRange"]);
      expect(r.uiSpec[0].severity).toBe("warning");
    });

    it("warns when the path walks through a scalar", () => {
      const spec = UISPEC.replace("spec.replicas", "spec.replicas.value");
      expect(codes(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec)).toEqual(["pathThroughScalar"]);
    });

    it("warns when render would have to create a list", () => {
      const spec = UISPEC.replace("spec.replicas", "spec.template.spec.volumes[0].name");
      expect(codes(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec)).toEqual(["pathAutoArray"]);
    });

    it("skips resolution while resources.yaml does not parse", () => {
      const broken = RESOURCES.replace("replicas: 1", "replicas: [1, 2");
      const r = validateTemplateYaml(broken, UISPEC.replace("[web]", "[nope]"), lookup);
      expect(r.uiSpec).toEqual([]);
    });

    it("errors on a path the backend refuses to save", () => {
      const cases: Array<[string, string]> = [
        ["deployment[web].spec.replicas", "pathInvalid"],
        ["Deployment[web]", "pathWholeResource"],
        ['Deployment[web].spec["replicas"]', "pathNotCanonical"],
        ["Deployment[web].metadata.namespace", "pathReserved"],
      ];
      for (const [path, code] of cases) {
        const r = validateTemplateYaml(RESOURCES, UISPEC.replace("Deployment[web].spec.replicas", path), lookup);
        expect(codes(r.uiSpec), path).toEqual([code]);
        expect(r.uiSpec[0].severity, path).toBe("error");
      }
    });

    it("errors on what else ValidateSpec refuses: shape, type and label", () => {
      expect(codes(validateTemplateYaml(RESOURCES, "fields: nope\n", lookup).uiSpec)).toEqual(["fieldsNotList"]);
      expect(codes(validateTemplateYaml(RESOURCES, "- a\n", lookup).uiSpec)).toEqual(["uiSpecNotMapping"]);
      expect(codes(validateTemplateYaml(RESOURCES, "fields:\n  - just text\n", lookup).uiSpec)).toEqual([
        "fieldNotMapping",
      ]);
      expect(codes(validateTemplateYaml(RESOURCES, UISPEC.replace("type: integer", "type: int"), lookup).uiSpec)).toEqual([
        "unknownType",
      ]);
      expect(codes(validateTemplateYaml(RESOURCES, UISPEC.replace('label: "인스턴스 개수"', 'label: "  "'), lookup).uiSpec)).toEqual([
        "missingLabel",
      ]);
      expect(codes(validateTemplateYaml(RESOURCES, "fields:\n", lookup).uiSpec)).toEqual([]);
    });
  });

  describe("(c) OpenAPI schema types", () => {
    it('warns on replicas: "many" at the value', () => {
      const bad = RESOURCES.replace("replicas: 1", 'replicas: "many"');
      const r = validateTemplateYaml(bad, UISPEC, lookup);
      expect(r.resources).toHaveLength(1);
      const [w] = r.resources;
      expect(w.severity).toBe("warning");
      expect(w.code).toBe("schemaType");
      expect(w.params).toMatchObject({ path: "spec.replicas", expected: "integer", actual: "string" });
      expect(w.startLine).toBe(5);
      expect(w.startCol).toBe(13);
    });

    it("checks inside lists and names the index", () => {
      const bad = RESOURCES.replace("containerPort: 80", "containerPort: http");
      const [w] = validateTemplateYaml(bad, UISPEC, lookup).resources;
      expect(w.params).toMatchObject({ path: "spec.template.spec.containers[0].ports[0].containerPort" });
    });

    it("flags a scalar where an object or list belongs", () => {
      const bad = RESOURCES.replace("replicas: 1", "replicas: 1\n  paused: yes please").replace(
        /containers:\n[\s\S]*$/,
        "containers: nginx\n",
      );
      const r = validateTemplateYaml(bad, "", lookup);
      expect(r.resources.map((i) => i.params.expected)).toEqual(["boolean", "array"]);
    });

    it("stays quiet for kinds with no schema, unknown keys, and null values", () => {
      const other = "apiVersion: example.com/v1\nkind: Widget\nmetadata: { name: w }\nspec: { size: big }\n";
      const extra = RESOURCES.replace("replicas: 1", "replicas: ~\n  madeUp: [1]");
      expect(validateTemplateYaml(other, "", lookup).resources).toEqual([]);
      expect(validateTemplateYaml(extra, UISPEC, lookup).resources).toEqual([]);
    });

    it("does not flag numbers in string-typed fields (Quantity, int-or-string)", () => {
      const lenient: SchemaLookup = () => ({
        type: "object",
        properties: { spec: { type: "object", properties: { memory: { type: "string" } } } },
      });
      const doc = "apiVersion: v1\nkind: X\nmetadata: { name: x }\nspec: { memory: 512 }\n";
      expect(validateTemplateYaml(doc, "", lenient).resources).toEqual([]);
    });

    it("runs without a schema lookup at all", () => {
      const bad = RESOURCES.replace("replicas: 1", 'replicas: "many"');
      expect(validateTemplateYaml(bad, UISPEC).resources).toEqual([]);
    });

    it("stops after a bounded number of issues on a huge document", () => {
      const items = Array.from({ length: 2000 }, () => "        - name: app\n          image: nginx\n          ports: [{ containerPort: x }]").join("\n");
      const huge = RESOURCES.replace(/      containers:\n[\s\S]*$/, `      containers:\n${items}\n`);
      const r = validateTemplateYaml(huge, "", lookup);
      expect(r.resources.length).toBeLessThanOrEqual(100);
      expect(r.resources.length).toBeGreaterThan(0);
    });
  });
});

describe("resourceKinds", () => {
  it("lists apiVersion/kind pairs from every parseable document", () => {
    const multi = `${RESOURCES}---\napiVersion: v1\nkind: Service\nmetadata: { name: web }\n---\n- not a doc\n`;
    expect(resourceKinds(multi)).toEqual([
      { apiVersion: "apps/v1", kind: "Deployment" },
      { apiVersion: "v1", kind: "Service" },
    ]);
  });
});
