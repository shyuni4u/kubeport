// What is wrong with a YAML-mode template, located to line and column (#181).
//
// YAML mode handed the admin two bare Monaco editors: a broken bracket, a
// string where Kubernetes wants an integer, or a ui-spec path pointing at a
// resource that had just been renamed all looked exactly like a correct
// template until the save came back 400 — or, for the last two, until a user's
// deploy failed.
//
// Severity follows what the backend does with the same input, so the editor
// never refuses something the API would take, nor waves through something it
// would not:
//
//   error    ValidateSpec (backend/internal/template/render.go) returns 400 on
//            save: YAML syntax, a resource document that is not a mapping, a
//            ui-spec that is not `fields: [mapping…]`, an unknown field type, a
//            blank label, and a path that does not parse, is not canonical,
//            selects a whole resource or sets a field kubeport reserves.
//   warning  The save succeeds and the template breaks later. ValidateSpec does
//            not look up the resource a path names (findDoc runs at render),
//            and nothing on the server checks resources against OpenAPI — the
//            apiserver does, at deploy, in front of the user.
//
// Pure and synchronous so the save handler can re-run it on the exact text it
// is about to send, rather than trusting a debounced result a keystroke old.

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  type Document,
  type Node as YamlNode,
} from "yaml";

import type { SchemaNode } from "./openapi";
import { canonicalizePath, joinPath, parseTemplatePath, splitHead } from "./template-path";

export type YamlFile = "resources" | "uiSpec";
export type YamlIssueSeverity = "error" | "warning";

/** Each code is a message key under `templates.editor.validation`, in both locales. */
export const YAML_ISSUE_CODES = [
  "syntax",
  "documentNotMapping",
  "uiSpecNotMapping",
  "fieldsNotList",
  "fieldNotMapping",
  "unknownType",
  "missingLabel",
  "pathMissing",
  "pathInvalid",
  "pathWholeResource",
  "pathNotCanonical",
  "pathReserved",
  "resourceNotFound",
  "resourceKindMissing",
  "resourceAmbiguous",
  "pathThroughScalar",
  "pathNotList",
  "pathIndexOutOfRange",
  "pathAutoArray",
  "schemaType",
] as const;
export type YamlIssueCode = (typeof YAML_ISSUE_CODES)[number];

export interface YamlIssue {
  file: YamlFile;
  severity: YamlIssueSeverity;
  code: YamlIssueCode;
  params: Record<string, string | number>;
  /** 1-based, Monaco's convention. `endCol` is exclusive. */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface TemplateYamlValidation {
  resources: YamlIssue[];
  uiSpec: YamlIssue[];
}

/** The resolved OpenAPI schema for a document's apiVersion and kind, if loaded. */
export type SchemaLookup = (apiVersion: string, kind: string) => SchemaNode | undefined;

// The same closed list as ValidateSpec and ui-spec-to-zod's KNOWN_TYPES.
const KNOWN_TYPES = new Set(["string", "integer", "boolean", "enum", "autocomplete"]);

// A pathological document must not freeze the editor on every keystroke: the
// schema walk is cut off by node count and depth, and each file's issue list
// by length. A hundred markers is already more than anyone reads.
const MAX_ISSUES_PER_FILE = 100;
const MAX_SCHEMA_VISITS = 20_000;
const MAX_SCHEMA_DEPTH = 64;

type Range = Pick<YamlIssue, "startLine" | "startCol" | "endLine" | "endCol">;

class Collector {
  readonly issues: YamlIssue[] = [];
  constructor(
    private readonly file: YamlFile,
    private readonly lc: LineCounter,
    private readonly text: string,
  ) {}

  get full(): boolean {
    return this.issues.length >= MAX_ISSUES_PER_FILE;
  }

  add(severity: YamlIssueSeverity, code: YamlIssueCode, at: [number, number], params: YamlIssue["params"] = {}) {
    if (this.full) return;
    this.issues.push({ file: this.file, severity, code, params, ...this.range(at) });
  }

  /** Offsets to 1-based positions. A zero-width range is widened to one column so it can be seen. */
  private range([start, end]: [number, number]): Range {
    const len = this.text.length;
    const s = Math.max(0, Math.min(start, len));
    const e = Math.max(s, Math.min(end, len));
    const a = this.lc.linePos(s);
    const b = this.lc.linePos(e);
    const startLine = Math.max(1, a.line);
    const endLine = Math.max(1, b.line);
    const endCol = endLine === startLine && b.col <= a.col ? a.col + 1 : b.col;
    return { startLine, startCol: a.col, endLine, endCol };
  }
}

function nodeRange(node: YamlNode | null | undefined, fallback: [number, number]): [number, number] {
  const r = node?.range;
  return r ? [r[0], r[1]] : fallback;
}

/** Parse every document, with a line counter to place what goes wrong. */
function parse(text: string) {
  const lc = new LineCounter();
  // prettyErrors off: the message is shown beside its line already, and the
  // pretty form appends a copy of the source with a caret under it.
  const docs = parseAllDocuments(text, { lineCounter: lc, prettyErrors: false });
  // An empty stream is its own type, iterable but not an array.
  return { lc, docs: Array.from(docs as Iterable<Document.Parsed>) };
}

function syntaxIssues(docs: Document.Parsed[], out: Collector): boolean {
  let any = false;
  for (const doc of docs) {
    for (const e of doc.errors) {
      any = true;
      out.add("error", "syntax", e.pos, { detail: e.message });
    }
  }
  return any;
}

function scalarText(node: unknown): string | null {
  if (!isScalar(node)) return null;
  const v = node.value;
  if (v === null || v === undefined) return null;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null;
}

// ---------------------------------------------------------------------------
// resources.yaml

interface ResourceDoc {
  kind: string;
  name: string | null;
  value: Record<string, unknown>;
}

function resourceDocs(docs: Document.Parsed[]): { list: ResourceDoc[]; nodes: Document.Parsed[] } {
  const list: ResourceDoc[] = [];
  const nodes: Document.Parsed[] = [];
  for (const doc of docs) {
    if (!isMap(doc.contents)) continue;
    let value: Record<string, unknown>;
    try {
      value = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
    } catch {
      // toJS refuses an alias bomb by throwing. This runs during render, so a
      // throw would take the editor and the unsaved draft with it (#164); the
      // document simply goes unresolved instead.
      continue;
    }
    const meta = value.metadata;
    const name =
      meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as Record<string, unknown>).name === "string"
        ? ((meta as Record<string, unknown>).name as string)
        : null;
    list.push({ kind: typeof value.kind === "string" ? value.kind : "", name, value });
    nodes.push(doc);
  }
  return { list, nodes };
}

/** apiVersion/kind of each mapping document, for the caller to fetch schemas by. */
export function resourceKinds(resourcesYaml: string): Array<{ apiVersion: string; kind: string }> {
  const out: Array<{ apiVersion: string; kind: string }> = [];
  const seen = new Set<string>();
  for (const doc of parse(resourcesYaml).docs) {
    if (doc.errors.length > 0 || !isMap(doc.contents)) continue;
    const apiVersion = scalarText(doc.contents.get("apiVersion", true));
    const kind = scalarText(doc.contents.get("kind", true));
    if (!apiVersion || !kind) continue;
    const key = `${apiVersion}/${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ apiVersion, kind });
  }
  return out;
}

// Kubernetes' OpenAPI marks these as strings although numbers are valid in
// them (resource.Quantity's `512`, IntOrString's `8080`), and a resolved schema
// no longer says which fields those are. So a number in a string field passes.
// Everything else the apiserver would refuse the same way.
function compatible(expected: string, actual: string): boolean {
  switch (expected) {
    case "integer":
      return actual === "integer";
    case "number":
      return actual === "integer" || actual === "number";
    case "string":
      return actual === "string" || actual === "integer" || actual === "number";
    default:
      return expected === actual;
  }
}

function ambiguousSchema(s: SchemaNode): boolean {
  const loose = s as SchemaNode & Record<string, unknown>;
  return (
    s.format === "int-or-string" ||
    loose["x-kubernetes-int-or-string"] === true ||
    Array.isArray(loose.oneOf) ||
    Array.isArray(loose.anyOf)
  );
}

function actualType(node: unknown): string | null {
  if (isMap(node)) return "object";
  if (isSeq(node)) return "array";
  if (!isScalar(node)) return null;
  const v = node.value;
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return null;
}

function schemaIssues(doc: Document.Parsed, schema: SchemaNode, out: Collector) {
  let visits = 0;
  const walk = (node: unknown, s: SchemaNode, path: string, depth: number) => {
    if (out.full || visits++ > MAX_SCHEMA_VISITS || depth > MAX_SCHEMA_DEPTH) return;
    if (node === null || node === undefined || isAlias(node)) return;
    if (isScalar(node) && (node.value === null || node.value === undefined)) return;
    if (ambiguousSchema(s)) return;
    const expected = s.type ?? (s.properties ? "object" : undefined);
    const actual = actualType(node);
    if (!expected || !actual) return;
    if (!compatible(expected, actual)) {
      out.add("warning", "schemaType", nodeRange(node as YamlNode, [0, 0]), {
        path: path || "(root)",
        expected,
        actual,
      });
      return;
    }
    if (isMap(node) && s.properties) {
      for (const pair of node.items) {
        const key = scalarText(pair.key);
        if (key === null) continue;
        const child = s.properties[key];
        if (!child) continue;
        walk(pair.value, child, joinPath(path, key) ?? `${path}.${key}`, depth + 1);
      }
    } else if (isSeq(node) && s.items) {
      node.items.forEach((item, i) => walk(item, s.items!, `${path}[${i}]`, depth + 1));
    }
  };
  walk(doc.contents, schema, "", 0);
}

// ---------------------------------------------------------------------------
// ui-spec.yaml

// Mirrors reservedPath in render.go.
function reservedPath(canon: string): boolean {
  if (["kind", "apiVersion", "metadata", "metadata.namespace"].includes(canon)) return true;
  return ["kind.", "apiVersion.", "metadata.namespace."].some((p) => canon.startsWith(p));
}

/** Where a render would fail to set this path, mirroring findDoc + setInto in jsonpath.go. */
function resolvePath(
  path: string,
  docs: ResourceDoc[],
): { code: YamlIssueCode; params: YamlIssue["params"] } | null {
  const parsed = parseTemplatePath(path);
  if (!parsed) return null;
  const { kind, selector, keys } = parsed;
  const ofKind = docs.filter((d) => d.kind === kind);
  let target: ResourceDoc | undefined;
  if (selector === "" && ofKind.length === 1) {
    target = ofKind[0];
  } else {
    // strconv.Atoi, which takes a sign.
    if (/^[+-]?\d+$/.test(selector)) {
      const idx = Number(selector);
      if (idx >= 0 && idx < ofKind.length) target = ofKind[idx];
    }
    target ??= ofKind.find((d) => d.name === selector);
  }
  if (!target) {
    if (ofKind.length === 0) return { code: selector ? "resourceNotFound" : "resourceKindMissing", params: { kind, selector } };
    if (selector === "") return { code: "resourceAmbiguous", params: { kind, count: ofKind.length } };
    return { code: "resourceNotFound", params: { kind, selector } };
  }

  let node: unknown = target.value;
  let at = "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const last = i === keys.length - 1;
    if (typeof k === "string") {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return { code: "pathThroughScalar", params: { at: at || kind } };
      }
      const obj = node as Record<string, unknown>;
      const next = joinPath(at, k) ?? k;
      if (last) return null;
      if (!(k in obj)) {
        if (typeof keys[i + 1] === "number") return { code: "pathAutoArray", params: { at: next } };
        // Render creates the map, and nothing below it exists either — but
        // the only way the rest can fail now is another array, checked above
        // on the next step. Model the empty map and carry on.
        node = {};
      } else {
        node = obj[k];
      }
      at = next;
    } else {
      if (!Array.isArray(node)) return { code: "pathNotList", params: { at: at || kind } };
      if (k >= node.length) return { code: "pathIndexOutOfRange", params: { at, item: k, length: node.length } };
      if (last) return null;
      node = node[k];
      at = `${at}[${k}]`;
    }
  }
  return null;
}

function uiSpecIssuesAt(doc: Document.Parsed, resources: ResourceDoc[] | null, out: Collector) {
  const root = doc.contents;
  if (root === null || (isScalar(root) && (root.value === null || root.value === undefined))) return;
  if (!isMap(root)) {
    out.add("error", "uiSpecNotMapping", nodeRange(root, doc.range ? [doc.range[0], doc.range[1]] : [0, 0]));
    return;
  }
  const fieldsPair = root.items.find((p) => scalarText(p.key) === "fields");
  const fields = fieldsPair?.value;
  if (!fieldsPair || fields === null || (isScalar(fields) && (fields.value === null || fields.value === undefined))) {
    return;
  }
  if (!isSeq(fields)) {
    out.add("error", "fieldsNotList", nodeRange(fields as YamlNode, nodeRange(fieldsPair.key as YamlNode, [0, 0])));
    return;
  }
  fields.items.forEach((entry, index) => {
    const entryRange = nodeRange(entry as YamlNode, nodeRange(fields, [0, 0]));
    if (!isMap(entry)) {
      out.add("error", "fieldNotMapping", entryRange, { index });
      return;
    }
    const get = (key: string) => entry.items.find((p) => scalarText(p.key) === key);
    // Only the first line of the entry: a whole-mapping range would underline
    // every setting when one of them is missing.
    const headRange: [number, number] = [entryRange[0], entryRange[0]];

    // Same order as ValidateSpec: type, label, path — one error per field.
    const typePair = get("type");
    const type = scalarText(typePair?.value) ?? "";
    if (!KNOWN_TYPES.has(type)) {
      out.add("error", "unknownType", nodeRange(typePair?.value as YamlNode, headRange), { index, type });
      return;
    }
    const labelPair = get("label");
    if ((scalarText(labelPair?.value) ?? "").trim() === "") {
      out.add("error", "missingLabel", nodeRange(labelPair?.value as YamlNode, headRange), { index });
      return;
    }
    const pathPair = get("path");
    const path = scalarText(pathPair?.value);
    const pathRange = nodeRange(pathPair?.value as YamlNode, headRange);
    if (!path) {
      out.add("error", "pathMissing", pathRange, { index });
      return;
    }
    const head = splitHead(path);
    const parsed = head ? parseTemplatePath(path) : null;
    if (!head || !parsed) {
      out.add("error", "pathInvalid", pathRange, { index, path });
      return;
    }
    if (parsed.keys.length === 0) {
      out.add("error", "pathWholeResource", pathRange, { index, path });
      return;
    }
    const canon = canonicalizePath(head.rest);
    if (canon === null) {
      out.add("error", "pathInvalid", pathRange, { index, path });
      return;
    }
    if (canon !== head.rest) {
      out.add("error", "pathNotCanonical", pathRange, {
        index,
        path,
        canonical: path.slice(0, path.length - head.rest.length) + canon,
      });
      return;
    }
    if (reservedPath(canon)) {
      out.add("error", "pathReserved", pathRange, { index, path, field: canon });
      return;
    }
    if (!resources) return;
    const miss = resolvePath(path, resources);
    if (miss) out.add("warning", miss.code, pathRange, { index, path, ...miss.params });
  });
}

// ---------------------------------------------------------------------------

export function validateTemplateYaml(
  resourcesYaml: string,
  uiSpecYaml: string,
  schemaFor?: SchemaLookup,
): TemplateYamlValidation {
  const res = parse(resourcesYaml);
  const resOut = new Collector("resources", res.lc, resourcesYaml);
  const resBroken = syntaxIssues(res.docs, resOut);
  if (!resBroken) {
    for (const doc of res.docs) {
      const c = doc.contents;
      // An empty document — a bare `---` or only comments — decodes to an
      // empty map in the backend and is dropped.
      if (c === null || (isScalar(c) && (c.value === null || c.value === undefined))) continue;
      if (!isMap(c)) {
        resOut.add("error", "documentNotMapping", nodeRange(c, [0, 0]), { found: isSeq(c) ? "list" : "scalar" });
      }
    }
  }
  const { list: resources, nodes } = resourceDocs(resBroken ? [] : res.docs);
  if (schemaFor && !resBroken) {
    nodes.forEach((doc, i) => {
      const apiVersion = scalarText((doc.contents as { get?: (k: string, keep: boolean) => unknown }).get?.("apiVersion", true));
      const kind = resources[i].kind;
      if (!apiVersion || !kind) return;
      const schema = schemaFor(apiVersion, kind);
      if (schema) schemaIssues(doc, schema, resOut);
    });
  }

  // yaml.Unmarshal reads the first document of ui-spec.yaml and nothing else.
  const spec = parse(uiSpecYaml);
  const specOut = new Collector("uiSpec", spec.lc, uiSpecYaml);
  const first = spec.docs.slice(0, 1);
  if (!syntaxIssues(first, specOut) && first[0]) {
    // Resolution needs resources that parse; until then only the path's own
    // grammar is checked.
    uiSpecIssuesAt(first[0], resBroken ? null : resources, specOut);
  }

  return { resources: resOut.issues, uiSpec: specOut.issues };
}

export function errorCount(v: TemplateYamlValidation): number {
  return [...v.resources, ...v.uiSpec].filter((i) => i.severity === "error").length;
}

export function firstError(v: TemplateYamlValidation): YamlIssue | undefined {
  return v.resources.find((i) => i.severity === "error") ?? v.uiSpec.find((i) => i.severity === "error");
}
