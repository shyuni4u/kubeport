import { describe, expect, it } from "vitest";

import type { SchemaNode } from "./openapi";
import {
  MAX_CHECKED_CHARS,
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

type Result = { resources: YamlIssue[]; uiSpec: YamlIssue[] };
const codes = (issues: YamlIssue[]) => issues.map((i) => i.code);
const errorsOf = (issues: YamlIssue[]) => issues.filter((i) => i.severity === "error");
/** Codes that would block save, across both files. */
const blocking = (r: Result) => errorsOf([...r.resources, ...r.uiSpec]).map((i) => i.code);
/** Everything but the guard's own note. */
const substantive = (issues: YamlIssue[]) => issues.filter((i) => i.code !== "advisoryOnly");

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
    it("blocks an unclosed flow sequence, marked at the bracket", () => {
      // The #181 repro. yaml.v3: "did not find expected ',' or ']'".
      const broken = RESOURCES.replace("replicas: 1", "replicas: [1, 2");
      const r = validateTemplateYaml(broken, UISPEC, lookup);
      // One issue: the parser's own complaint a line further down is the
      // bracket's echo, not a second problem.
      expect(r.resources).toHaveLength(1);
      expect(r.resources[0]).toMatchObject({
        severity: "error",
        code: "unclosedFlow",
        params: { bracket: "[" },
        startLine: 5,
        startCol: 13,
        endLine: 5,
        endCol: 14,
      });
    });

    it("reports a syntax error in ui-spec.yaml against that file", () => {
      const r = validateTemplateYaml(RESOURCES, "fields:\n  - path: [\n", lookup);
      expect(codes(errorsOf(r.uiSpec))).toEqual(["unclosedFlow"]);
      expect(r.resources).toEqual([]);
    });

    it("reports a syntax error in the second document of a multi-document file", () => {
      const multi = `${RESOURCES}---\napiVersion: v1\nkind: Service\nmetadata: { name: web\n`;
      const r = validateTemplateYaml(multi, UISPEC, lookup);
      const errs = errorsOf(r.resources);
      expect(codes(errs)).toEqual(["unclosedFlow"]);
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

    it("judges a blank label by Go's strings.TrimSpace, not String.trim", () => {
      const withLabel = (label: string) => UISPEC.replace('label: "인스턴스 개수"', `label: "${label}"`);
      // yaml.v3 + TrimSpace: a lone BOM is a label; NEL and NBSP are blank (measured).
      expect(blocking(validateTemplateYaml(RESOURCES, withLabel("\uFEFF"), lookup))).toEqual([]);
      expect(blocking(validateTemplateYaml(RESOURCES, withLabel("\u0085"), lookup))).toEqual(["missingLabel"]);
      expect(blocking(validateTemplateYaml(RESOURCES, withLabel("\u00A0"), lookup))).toEqual(["missingLabel"]);
    });
  });

  // gopkg.in/yaml.v3 resolves anchors, aliases and `<<` merge keys before
  // ValidateSpec sees a field. Each case here was run through the real
  // ValidateSpec / parseMultiDoc. All of them trip the structural guard, so
  // nothing here blocks; resolution still decides what is reported, and where.
  describe("(d) YAML the backend resolves", () => {
    const P = "Deployment[web].spec.replicas";

    it("accepts a field entry built from an anchor and a merge key", () => {
      const spec = `base: &base\n  type: integer\n  label: Replicas\nfields:\n  - <<: *base\n    path: ${P}\n`;
      expect(substantive(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec)).toEqual([]);
    });

    it("accepts an aliased fields list", () => {
      const spec = `x: &list\n  - path: ${P}\n    label: R\n    type: integer\nfields: *list\n`;
      expect(substantive(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec)).toEqual([]);
    });

    it("accepts an aliased scalar label, a whole aliased entry and an aliased key", () => {
      const label = `l: &l Replicas\nfields:\n  - path: ${P}\n    label: *l\n    type: integer\n`;
      const entry = `e: &e {path: "${P}", label: R, type: integer}\nfields:\n  - *e\n`;
      const key = `k: &k label\nfields:\n  - path: ${P}\n    *k : R\n    type: integer\n`;
      for (const spec of [label, entry, key]) {
        expect(substantive(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec), spec).toEqual([]);
      }
    });

    it("still reports an alias to an empty label, as a warning", () => {
      const spec = `l: &l ""\nfields:\n  - path: ${P}\n    label: *l\n    type: integer\n`;
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(blocking(r)).toEqual([]);
      expect(codes(substantive(r.uiSpec))).toEqual(["missingLabel"]);
    });

    it("follows merge precedence: explicit keys win, then the first source", () => {
      const anchors = "bad: &bad {type: int, label: R}\ngood: &good {type: integer, label: R}\n";
      const entry = (body: string) => `${anchors}fields:\n  - ${body}\n    path: ${P}\n`;
      const found = (body: string) => codes(substantive(validateTemplateYaml(RESOURCES, entry(body), lookup).uiSpec));
      expect(found("<<: [*good, *bad]")).toEqual([]);
      expect(found("<<: [*bad, *good]")).toEqual(["unknownType"]);
      expect(found("<<: *bad\n    type: integer")).toEqual([]);
      expect(found("type: integer\n    <<: *bad")).toEqual([]);
      // A merge chain: the anchor merges another.
      const chain = `a: &a {type: integer}\nb: &b {<<: *a, label: R}\nfields:\n  - <<: *b\n    path: ${P}\n`;
      expect(substantive(validateTemplateYaml(RESOURCES, chain, lookup).uiSpec)).toEqual([]);
    });

    it("honours the merge tag in every spelling yaml.v3 does, and only those", () => {
      const spec = (key: string) => `d: &d {type: integer, label: R}\nfields:\n  - ${key}: *d\n    path: ${P}\n`;
      for (const key of ["!!merge '<<'", "!!merge <<", '!!merge "<<"', "!<tag:yaml.org,2002:merge> <<", "! <<"]) {
        const r = validateTemplateYaml(RESOURCES, spec(key), lookup);
        expect(blocking(r), key).toEqual([]);
        expect(substantive(r.uiSpec), key).toEqual([]);
      }
      // Ordinary keys to yaml.v3, so the entry has no type (measured).
      for (const key of ["!!str <<", "!!merge foo", '"<<"']) {
        const r = validateTemplateYaml(RESOURCES, spec(key), lookup);
        expect(blocking(r), key).toEqual([]);
        expect(codes(substantive(r.uiSpec)), key).toEqual(["unknownType"]);
      }
    });

    it("places a merged field's problem on the merge in that entry", () => {
      const spec = `bad: &bad {type: int, label: R}\nfields:\n  - <<: *bad\n    path: ${P}\n`;
      const [e] = substantive(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec);
      expect(e).toMatchObject({ code: "unknownType", startLine: 3, startCol: 9 });
    });

    it("reports two merge keys in one mapping, which yaml.v3 refuses as a repeated key", () => {
      const spec = `a: &a {type: integer}\nb: &b {label: R}\nfields:\n  - <<: *a\n    <<: *b\n    path: ${P}\n`;
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(blocking(r)).toEqual([]);
      expect(codes(substantive(r.uiSpec))).toContain("duplicateKey");
    });

    it("stays quiet about what it cannot resolve: a missing anchor, a merged scalar", () => {
      const missing = `fields:\n  - <<: *nope\n    path: ${P}\n`;
      const scalar = `s: &s hello\nfields:\n  - <<: *s\n    path: ${P}\n    label: R\n    type: integer\n`;
      for (const spec of [missing, scalar]) {
        expect(blocking(validateTemplateYaml(RESOURCES, spec, lookup)), spec).toEqual([]);
      }
    });

    it("skips a null entry, which yaml.v3 saves", () => {
      expect(validateTemplateYaml(RESOURCES, "fields:\n  - ~\n", lookup).uiSpec).toEqual([]);
    });

    it("accepts flow style and block scalars the backend reads the same way", () => {
      const specs = [
        `fields: [{path: "${P}", label: R, type: integer}]\n`,
        `fields:\n  - path: ${P}\n    label: |\n      Replicas\n    type: integer\n`,
        `fields:\n  - path: >-\n      ${P}\n    label: R\n    type: integer\n`,
        `fields:\n  - path: ${P}\n    label: true\n    type: integer\n`,
      ];
      for (const spec of specs) {
        expect(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec, spec).toEqual([]);
      }
    });

    it("accepts tagged values, with only the guard's note", () => {
      const specs = [
        `fields:\n  - path: !!str ${P}\n    label: !!str 3\n    type: !!str integer\n`,
        `fields:\n  - path: ${P}\n    label: !!binary aGVsbG8=\n    type: integer\n`,
      ];
      for (const spec of specs) {
        const r = validateTemplateYaml(RESOURCES, spec, lookup);
        expect(codes(r.uiSpec), spec).toEqual(["advisoryOnly"]);
      }
    });

    it("refuses a literal block path, whose trailing newline yaml.v3 keeps", () => {
      const spec = `fields:\n  - path: |\n      ${P}\n    label: R\n    type: integer\n`;
      expect(blocking(validateTemplateYaml(RESOURCES, spec, lookup))).toEqual(["pathInvalid"]);
    });

    it("resolves aliases and merges in resources.yaml", () => {
      const res = `apiVersion: apps/v1
kind: Deployment
metadata: &meta { name: web }
x-containers: &cs
  - name: app
    image: nginx
podBase: &pod { containers: *cs }
spec:
  replicas: 1
  template:
    metadata: *meta
    spec:
      <<: *pod
`;
      const spec = `fields:\n  - path: Deployment[web].spec.template.spec.containers[0].image\n    label: Image\n    type: string\n`;
      const r = validateTemplateYaml(res, spec, lookup);
      expect(substantive(r.resources)).toEqual([]);
      expect(r.uiSpec).toEqual([]);
    });

    it("finds a resource whose kind and name come from a merge", () => {
      const res = "x: &x {apiVersion: v1, kind: ConfigMap, metadata: {name: web}}\n<<: *x\ndata: {a: '1'}\n";
      const spec = "fields:\n  - path: ConfigMap[web].data.a\n    label: A\n    type: string\n";
      expect(validateTemplateYaml(res, spec, lookup).uiSpec).toEqual([]);
      expect(resourceKinds(res)).toEqual([{ apiVersion: "v1", kind: "ConfigMap" }]);
    });

    it("resolves an alias to an anchor in an earlier document, as yaml.v3's decoder does", () => {
      const res = `apiVersion: v1\nkind: ConfigMap\nmetadata: &m {name: a}\n---\napiVersion: v1\nkind: Secret\nmetadata: *m\n`;
      const spec = "fields:\n  - path: Secret[a].stringData.k\n    label: K\n    type: string\n";
      const r = validateTemplateYaml(res, spec, lookup);
      expect(substantive(r.resources)).toEqual([]);
      expect(r.uiSpec).toEqual([]);
    });

    it("gives up quietly on an alias bomb in either file", () => {
      const levels = ["a: &a [x, x, x, x, x, x, x, x, x]"];
      for (let i = 1; i < 9; i++) {
        const prev = String.fromCharCode(96 + i);
        const cur = String.fromCharCode(97 + i);
        levels.push(`${cur}: &${cur} [${Array(9).fill(`*${prev}`).join(", ")}]`);
      }
      const resBomb = `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: x }\n${levels.join("\n")}\nspec: *i\n`;
      const specBomb = `${levels.join("\n")}\nfields:\n  - path: ConfigMap[x].spec.k\n    label: K\n    type: string\n`;
      const r = validateTemplateYaml(resBomb, specBomb, lookup);
      expect(blocking(r)).toEqual([]);
      expect(substantive(r.uiSpec)).toEqual([]);
    });
  });

  // What yaml.v3 actually decodes. Each input was run through the real
  // parseMultiDoc / ValidateSpec first.
  describe("(g) only what the backend decodes", () => {
    const NESTED_ANCHOR =
      "x: &m {apiVersion: v1, kind: ConfigMap, metadata: {name: b}}\napiVersion: v1\nkind: Secret\nmetadata: {name: a}\n---\n*m\n";

    it("resolves a document whose root is an alias to an earlier anchor", () => {
      const spec = "fields:\n  - path: ConfigMap[b].data.k\n    label: K\n    type: string\n";
      const r = validateTemplateYaml(NESTED_ANCHOR, spec, lookup);
      expect(substantive(r.resources)).toEqual([]);
      expect(r.uiSpec).toEqual([]);
      expect(resourceKinds(NESTED_ANCHOR)).toEqual([
        { apiVersion: "v1", kind: "Secret" },
        { apiVersion: "v1", kind: "ConfigMap" },
      ]);
    });

    it("counts an aliased whole document as a document of its kind", () => {
      const res = "--- &m\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n*m\n";
      const spec = "fields:\n  - path: ConfigMap.data.k\n    label: K\n    type: string\n";
      const r = validateTemplateYaml(res, spec, lookup);
      expect(substantive(r.resources)).toEqual([]);
      expect(codes(r.uiSpec)).toEqual(["resourceAmbiguous"]);
    });

    it("reports a root alias to a scalar, and drops one to null as parseMultiDoc does", () => {
      const scalar = validateTemplateYaml("x: &s hello\nkind: A\n---\n*s\n", "", lookup);
      expect(blocking(scalar)).toEqual([]);
      expect(codes(substantive(scalar.resources))).toEqual(["documentNotMapping"]);
      const res =
        "x: &n ~\nkind: ConfigMap\nmetadata: {name: a}\n---\n*n\n---\nkind: ConfigMap\nmetadata: {name: b}\n";
      const spec = "fields:\n  - path: ConfigMap[1].data.k\n    label: K\n    type: string\n";
      const r = validateTemplateYaml(res, spec, lookup);
      expect(substantive(r.resources)).toEqual([]);
      expect(r.uiSpec).toEqual([]);
    });

    it("does not block a root alias to an anchor it cannot find", () => {
      expect(blocking(validateTemplateYaml("kind: A\n---\n*nope\n", "", lookup))).toEqual([]);
    });

    it("type-checks an aliased document root once", () => {
      const res =
        "x: &m {apiVersion: apps/v1, kind: Deployment, metadata: {name: b}, spec: {replicas: many}}\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\n*m\n";
      expect(codes(substantive(validateTemplateYaml(res, "", lookup).resources))).toEqual(["schemaType"]);
    });

    it("blocks a repeated key anywhere in a plain resources.yaml, which decodes whole", () => {
      const res = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\nunused: {a: 1, a: 2}\n";
      expect(blocking(validateTemplateYaml(res, "", lookup))).toEqual(["duplicateKey"]);
      // Behind a merge it is still found, and only reported.
      const merged = validateTemplateYaml("base: &b {a: 1, a: 2}\ndata:\n  <<: *b\n", "", lookup);
      expect(blocking(merged)).toEqual([]);
      expect(codes(substantive(merged.resources))).toContain("duplicateKey");
    });

    const P = "Deployment[web].spec.replicas";
    const ENTRY = `fields:\n  - path: ${P}\n    label: R\n    type: integer\n`;

    it.each([
      ["the root's own keys", "x: 1\nx: 2\nfields: []\n"],
      ["a default value", `${ENTRY}    default: {a: 1, a: 2}\n`],
      ["a nested default value", `${ENTRY}    default: {x: {a: 1, a: 2}}\n`],
      ["help", `${ENTRY}    help: {a: 1, a: 2}\n`],
      ["values", `fields:\n  - path: ${P}\n    label: R\n    type: enum\n    values: {a: 1, a: 2}\n`],
      ["a field entry's unknown keys", `${ENTRY}    x: 1\n    x: 2\n`],
    ])("blocks a repeated key in %s of ui-spec.yaml", (_name, spec) => {
      expect(blocking(validateTemplateYaml(RESOURCES, spec, lookup))).toEqual(["duplicateKey"]);
    });

    it.each([
      ["an aliased default value", `d: &d {a: 1, a: 2}\n${ENTRY}    default: *d\n`],
      ["a merge source of an entry", `base: &b {type: integer, label: R, zz: 1, zz: 2}\nfields:\n  - <<: *b\n    path: ${P}\n`],
      ["a merge source's default", `base: &b {type: integer, label: R, default: {a: 1, a: 2}}\nfields:\n  - <<: *b\n    path: ${P}\n`],
      ["an aliased entry", `e: &e {path: "${P}", label: R, type: integer, zz: 1, zz: 2}\nfields:\n  - *e\n`],
      ["an entry of an aliased fields list", `l: &l\n  - {path: "${P}", label: R, type: integer, label: S}\nfields: *l\n`],
      ["a merge source of the root", "base: &b {q: 1, q: 2}\n<<: *b\nfields: []\n"],
    ])("reports, without blocking, a repeated key yaml.v3 decodes through %s", (_name, spec) => {
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(blocking(r)).toEqual([]);
      expect(codes(substantive(r.uiSpec))).toContain("duplicateKey");
    });

    it.each([
      ["an unknown root key's value", "unused: {a: 1, a: 2}\nfields: []\n"],
      ["an unknown entry key's value", `${ENTRY}    extra: {a: 1, a: 2}\n`],
      ["an unknown key of a merge source", `base: &b {type: integer, label: R, extra: {a: 1, a: 2}}\nfields:\n  - <<: *b\n    path: ${P}\n`],
      ["a list under an unknown root key", "fields: []\nother: [{a: 1, a: 2}]\n"],
    ])("only warns about a repeated key in %s, which yaml.v3 never decodes", (_name, spec) => {
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(errorsOf(r.uiSpec)).toEqual([]);
      expect(r.uiSpec.map((i) => [i.severity, i.code])).toContainEqual(["warning", "duplicateKey"]);
    });
  });

  // One construct at a time, each beside a problem that would otherwise block.
  describe("(h) structural guard", () => {
    const expectAdvisory = (issues: YamlIssue[], construct: string) => {
      expect(errorsOf(issues)).toEqual([]);
      expect(issues[0]).toMatchObject({ severity: "warning", code: "advisoryOnly", params: { construct } });
      expect(substantive(issues).length).toBeGreaterThan(0);
    };

    it.each([
      ["tag", "x: !!str a\nfields: nope\n"],
      ["anchor", "x: &a 1\nfields: nope\n"],
      ["alias", "fields: nope\ny: *a\n"],
      ["merge", "fields:\n  - <<: {type: int}\n    path: Deployment[web].spec.replicas\n    label: R\n"],
      ["directive", "%YAML 1.2\n---\nfields: nope\n"],
      ["documents", "---\nfields: nope\n---\n"],
      ["documents", "fields: nope\n...\n"],
    ])("downgrades every error in a ui-spec.yaml with a %s", (construct, spec) => {
      expectAdvisory(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec, construct);
    });

    it.each([
      ["tag", "apiVersion: !!str v1\nkind: ConfigMap\nmetadata: {name: a}\ndata: [\n"],
      ["anchor", "apiVersion: v1\nkind: ConfigMap\nmetadata: &m {name: a}\nx: 1\nx: 2\n"],
      ["merge", "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\ndata:\n  <<: {a: '1'}\n  b: 1\n  b: 2\n"],
      ["directive", "%YAML 1.2\n---\n- not a mapping\n"],
    ])("downgrades every error in a resources.yaml with a %s", (construct, res) => {
      expectAdvisory(validateTemplateYaml(res, "", lookup).resources, construct);
    });

    it("does not guard resources.yaml for having several documents", () => {
      const r = validateTemplateYaml("a: 1\n---\nb: [\n", "", lookup);
      expect(codes(r.resources)).toEqual(["unclosedFlow"]);
      expect(r.resources[0].severity).toBe("error");
    });

    it("still blocks the plain #181 repro and a plain repeated key", () => {
      const repro = validateTemplateYaml(RESOURCES.replace("replicas: 1", "replicas: [1, 2"), UISPEC, lookup);
      expect(blocking(repro)).toEqual(["unclosedFlow"]);
      expect(blocking(validateTemplateYaml("a: 1\na: 2\n", "", lookup))).toEqual(["duplicateKey"]);
    });

    it("ends ui-spec.yaml's first document at a second ---, even an empty one", () => {
      // yaml.Unmarshal reads the empty first document and stops (measured).
      const r = validateTemplateYaml(RESOURCES, "---\n---\nx: [\n", lookup);
      expect(errorsOf(r.uiSpec)).toEqual([]);
      expect(codes(r.uiSpec)).not.toContain("unclosedFlow");
    });

    it("reads resources.yaml past an empty first document, as parseMultiDoc does", () => {
      expect(blocking(validateTemplateYaml("---\n---\nx: [\n", "", lookup))).toEqual(["unclosedFlow"]);
    });
  });

  // Stored input: the next visitor to open a version pays for whatever is in it.
  describe("(f) size and depth", () => {
    const CONFIGMAP = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: big }\ndata:\n";
    // Linear time is judged by growth, not by a wall-clock budget. The suite
    // runs on shared CI runners and on a machine several sessions test on at
    // once, where the same call takes twice as long for reasons unrelated to
    // the code: a 500ms budget passed at 375ms alone and failed at 685ms under
    // the full suite. Quadrupling the input should about quadruple the time;
    // the quadratic paths these guard (duplicate keys, anchor lookup) grew 16x.
    // Small and large runs alternate, so load lands on both and each call is a
    // different text than the last — the per-file parse cache can't answer it.
    const GROWTH_LIMIT = 10;
    const growth = (small: string, large: string, run: (text: string) => void) => {
      let s = Infinity;
      let l = Infinity;
      for (let k = 0; k < 3; k++) {
        let t0 = performance.now();
        run(small);
        s = Math.min(s, performance.now() - t0);
        t0 = performance.now();
        run(large);
        l = Math.min(l, performance.now() - t0);
      }
      return { small: s, large: l };
    };
    const expectLinear = ({ small, large }: { small: number; large: number }, what: string) => {
      // The floor keeps a sub-millisecond small run from turning timer noise into a ratio.
      expect(large, `${what}: ${large.toFixed(1)}ms vs ${small.toFixed(1)}ms at a quarter of the size`).toBeLessThan(
        Math.max(small * GROWTH_LIMIT, 50),
      );
    };

    it("skips a file too large to check, without blocking", () => {
      const keys = Array.from({ length: 20_000 }, (_, i) => `  k${i}: "v${i}"`).join("\n");
      const res = `${CONFIGMAP}${keys}\n`;
      expect(res.length).toBeGreaterThan(MAX_CHECKED_CHARS);
      const r = validateTemplateYaml(res, UISPEC, lookup);
      expect(r.resources).toEqual([
        expect.objectContaining({ severity: "warning", code: "tooLarge", startLine: 1, startCol: 1 }),
      ]);
      expect(errorsOf(r!.uiSpec)).toEqual([]);
      expect(resourceKinds(res)).toEqual([]);
    });

    it("skips a too-large ui-spec the same way", () => {
      const spec = `fields: []\n${"# padding\n".repeat(MAX_CHECKED_CHARS / 10 + 1)}`;
      const r = validateTemplateYaml(RESOURCES, spec, lookup);
      expect(r.uiSpec.map((i) => [i.severity, i.code])).toEqual([["warning", "tooLarge"]]);
    });

    it("checks a many-key file just under the limit in linear time, duplicates included", () => {
      const lines: string[] = [];
      let size = CONFIGMAP.length + 20;
      for (let i = 0; ; i++) {
        const line = `  k${i}: v\n`;
        if (size + line.length > MAX_CHECKED_CHARS) break;
        lines.push(line);
        size += line.length;
      }
      const file = (keyLines: string[]) => `${CONFIGMAP}${keyLines.join("")}  k0: again\n`;
      const res = file(lines);
      expect(res.length).toBeLessThanOrEqual(MAX_CHECKED_CHARS);
      expect(lines.length).toBeGreaterThan(5_000);
      // The quadratic parse took seconds here.
      const quarter = file(lines.slice(0, Math.floor(lines.length / 4)));
      expectLinear(growth(quarter, res, (text) => validateTemplateYaml(text, "", lookup)), "many keys");
      expect(codes(errorsOf(validateTemplateYaml(res, "", lookup).resources))).toEqual(["duplicateKey"]);
    });

    // Both shapes save (measured), so a demo visitor can store one. Anchor
    // lookup was quadratic in them: 9.9s and 4.4s at 256k characters.
    const anchorsPerDocument = (n: number) => `--- &z {kind: A}\n${"--- {a: *z}\n".repeat(n)}`;
    const anchorsInAList = (n: number) => `kind: A\nx:\n${"- &a 1\n- *a\n".repeat(n)}`;

    it.each([
      ["an anchor used from every later document", anchorsPerDocument],
      ["an anchor redefined and used down a list", anchorsInAList],
    ])("resolves %s in linear time", (name, shape) => {
      const n = Math.floor((MAX_CHECKED_CHARS - 40) / 12);
      const res = shape(n);
      expect(res.length).toBeLessThanOrEqual(MAX_CHECKED_CHARS);
      expectLinear(growth(shape(Math.floor(n / 4)), res, (text) => validateTemplateYaml(text, "", lookup)), name);
      expect(blocking(validateTemplateYaml(res, "", lookup))).toEqual([]);
    });

    it("refuses flow nesting deeper than yaml.v3's 10000 levels, without parsing it", () => {
      const nest = (n: number) => `x: ${"[".repeat(n)}${"]".repeat(n)}\n`;
      const deep = validateTemplateYaml(nest(10_001), "", lookup);
      expect(deep.resources).toEqual([expect.objectContaining({ severity: "error", code: "tooDeep", startLine: 1 })]);
      expect(resourceKinds(nest(10_001))).toEqual([]);
      // 10000 saves; the `yaml` parser gives up sooner, which only warns.
      expect(blocking(validateTemplateYaml(nest(10_000), "", lookup))).toEqual([]);
      // In a ui-spec document yaml.Unmarshal never reads, it saves.
      expect(blocking(validateTemplateYaml(RESOURCES, `fields: []\n---\n${nest(10_001)}`, lookup))).toEqual([]);
    });
  });

  // The `yaml` parser is stricter than gopkg.in/yaml.v3. Every input here was
  // run through the real parseMultiDoc / ValidateSpec first.
  describe("(e) parser strictness", () => {
    const HEAD = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\nspec:\n";
    const POD = `${HEAD}  containers:\n    - name: app\n`;
    const CM = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n";

    it.each([
      ["a flow list indented less than its key", `${HEAD}      containers: [\n      {name: app, image: nginx}\n  ]\n`],
      ["a flow list continued at column 0", `${POD}      args: ["a",\n"b"]\n`],
      ["a tab inside a flow list", `${POD}      args: [\n\t"a"]\n`],
      ["a comment with no space before #", 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: "web"# name\n'],
      // The lexer abandons these lists and reads `]` as part of a plain scalar.
      ["an under-indented list ending in a plain scalar", `${POD}      command: [sh, -c,\n    echo hi]\n`],
      ["a plain continuation indented less than its key", `${POD}      args: [a,\n  b]\n`],
      ["a plain continuation at column 0", `${POD}      args: [a,\nb]\n`],
      ["a plain continuation after a tab", `${POD}      args: [a,\n\tb]\n`],
      ["a flow mapping continued at column 0", `${POD}      env: [{name: a,\nvalue: b}]\n`],
      ["a nested list continued at column 0", `${POD}      args: [\n[a],\n"b"]\n`],
      // A comment ends at these for yaml.v3, not for the `yaml` lexer.
      ["a comment ended by U+2028", `${CM}extra: [b # c\u2028]\n`],
      ["a comment ended by a lone CR", `${CM}extra: [b # c\r]\n`],
      ["a comment ended by NEL", `${CM}extra: [b # c\u0085]\n`],
    ])("does not block save on %s, which yaml.v3 accepts", (_name, res) => {
      const r = validateTemplateYaml(res, "", lookup);
      expect(errorsOf(r.resources)).toEqual([]);
    });

    it("warns rather than blocks on what only the `yaml` parser refuses", () => {
      const r = validateTemplateYaml(`${POD}      command: [sh, -c,\n    echo hi]\n`, "", lookup);
      expect(r.resources.length).toBeGreaterThan(0);
      expect(r.resources.every((i) => i.severity === "warning" && i.code === "syntax")).toBe(true);
    });

    it("does not read a key inside an abandoned flow list as a repeated top-level key", () => {
      const r = validateTemplateYaml('b: 1\nx: [\n"b": 2]\n', "", lookup);
      expect(errorsOf(r.resources)).toEqual([]);
    });

    it("does not read a bracket inside a tag as a flow list", () => {
      expect(blocking(validateTemplateYaml(`${CM}extra: !x[ b\n`, "", lookup))).toEqual([]);
    });

    it("still blocks lists that yaml.v3 finds unclosed", () => {
      expect(blocking(validateTemplateYaml("x: [a,\nb", "", lookup))).toEqual(["unclosedFlow"]);
      expect(blocking(validateTemplateYaml(`${POD}      args: [a,\n    b\n`, "", lookup))).toEqual(["unclosedFlow"]);
    });

    it("blocks an unclosed { at the bracket, per document", () => {
      const r = validateTemplateYaml("a: {b: 1\n---\nc: 1\n", "", lookup);
      expect(r.resources.map((i) => [i.code, i.startLine, i.startCol])).toEqual([["unclosedFlow", 1, 4]]);
    });

    it("does not count brackets inside quoted or block scalars, or comments", () => {
      const res = "a: \"[\"\nb: '{'\nc: |\n  [\nd: 1 # [\ne: [1, # ]\n  2]\nf: b[c\n";
      expect(validateTemplateYaml(res, "", lookup).resources).toEqual([]);
    });

    it("blocks a key repeated by text, as yaml.v3 compares keys", () => {
      for (const res of ['a: 1\n"a": 2\n', "'a': 1\n\"a\": 2\n", "m:\n  k: 1\n  k: 2\n", "{a: 1, a: 2}\n"]) {
        expect(codes(errorsOf(validateTemplateYaml(res, "", lookup).resources)), res).toEqual(["duplicateKey"]);
      }
      expect(validateTemplateYaml("m:\n  k: 1\n  k: 2\n", "", lookup).resources).toEqual([
        expect.objectContaining({ code: "duplicateKey", startLine: 3, startCol: 3, params: { key: "k" } }),
      ]);
      const spec = UISPEC.replace("type: integer", "label: again\n    type: integer");
      expect(codes(errorsOf(validateTemplateYaml(RESOURCES, spec, lookup).uiSpec))).toEqual(["duplicateKey"]);
    });

    it("does not block keys the yaml parser calls equal and yaml.v3 does not", () => {
      for (const res of ["0x1: a\n1: b\n", "~: a\nnull: b\n", "1.0: a\n1: b\n"]) {
        expect(errorsOf(validateTemplateYaml(res, "", lookup).resources), res).toEqual([]);
      }
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

    it("stops after a bounded number of issues on a large document", () => {
      const items = Array.from({ length: 600 }, () => "        - name: app\n          image: nginx\n          ports: [{ containerPort: x }]").join("\n");
      const huge = RESOURCES.replace(/      containers:\n[\s\S]*$/, `      containers:\n${items}\n`);
      expect(huge.length).toBeLessThanOrEqual(MAX_CHECKED_CHARS);
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
