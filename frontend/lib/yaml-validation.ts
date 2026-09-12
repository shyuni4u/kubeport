// What is wrong with a YAML-mode template, located to line and column (#181).
//
// YAML mode handed the admin two bare Monaco editors: a broken bracket, a
// string where Kubernetes wants an integer, or a ui-spec path pointing at a
// resource that had just been renamed all looked exactly like a correct
// template until the save came back 400 — or, for the last two, until a user's
// deploy failed.
//
// The rule is one-sided: never refuse a save the backend would accept. Only
// what this file can be sure gopkg.in/yaml.v3 and ValidateSpec
// (backend/internal/template/render.go) refuse is an error, and only errors
// block save. Each kind of error below was run through the real backend.
//
//   error    An unclosed `[` or `{` ("did not find expected ',' or ']'").
//            A key repeated in a mapping yaml.v3 decodes, compared as it compares
//            keys — by text, so `a` and "a" collide while `0x1` and `1` do not.
//            That is every mapping in resources.yaml, but in ui-spec.yaml only
//            the root, the field entries (merge sources included) and the values
//            of their known keys. An unknown key's value is never decoded, so a
//            repeat inside one is a warning.
//            A resource document that is not a mapping; a ui-spec that is not
//            `fields: [mapping…]`; an unknown field type; a blank label; a path
//            that does not parse, is not canonical, selects a whole resource or
//            sets a field kubeport reserves.
//   warning  Anything else the `yaml` parser complains about. It is stricter
//            than yaml.v3 — a flow list indented less than its key, a `#` with
//            no space before it — so its errors cannot block on their own.
//            A path whose resource is missing, and a value whose type does not
//            match the cluster's OpenAPI schema: ValidateSpec never looks, the
//            save succeeds, and a deploy trips over them later.
//
// That is a subset of ValidateSpec, not all of it. An invalid `pattern`, a
// non-integer `min`/`max` and a non-boolean `required` pass here and are
// refused by the save itself, whose 400 message the editor shows. Pattern
// rules belong to ui-spec-to-zod, where RE2 and JavaScript regexes differ.
//
// Anchors, aliases and `<<` merge keys are resolved the way yaml.v3 resolves
// them before a field is judged. When resolution cannot finish — an unknown
// anchor, a merge of a scalar, a budget spent on an alias bomb — the check is
// skipped, not guessed.
//
// Pure and synchronous so the save handler can re-run it on the exact text it
// is about to send, rather than trusting a debounced result a keystroke old.

import {
  CST,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  Lexer,
  LineCounter,
  parseAllDocuments,
  visit,
  type Alias,
  type Document,
  type Node as YamlNode,
  type Pair,
  type YAMLMap,
} from "yaml";

import type { SchemaNode } from "./openapi";
import { canonicalizePath, joinPath, parseTemplatePath, splitHead } from "./template-path";

export type YamlFile = "resources" | "uiSpec";
export type YamlIssueSeverity = "error" | "warning";

/** Each code is a message key under `templates.editor.validation`, in both locales. */
export const YAML_ISSUE_CODES = [
  "tooLarge",
  "syntax",
  "unclosedFlow",
  "duplicateKey",
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

// A pathological document must not freeze the editor on every keystroke, and
// a template version is stored input the next visitor opens. What bounds it:
//
// - Size. A file longer than MAX_CHECKED_CHARS is not parsed at all; it gets a
//   `tooLarge` warning and the save's own validation.
// - The parse. The `yaml` parser's duplicate-key check compares each key with
//   every earlier key of its mapping — a 20k-key ConfigMap took 22s — so it
//   runs with `uniqueKeys: false`, and duplicateKeyIssues does that job with a
//   Set per mapping.
// - Repetition. Parses are cached by exact text, so the debounced check,
//   resourceKinds and the save handler's re-check of unchanged text share one.
// - The walks after it: the schema walk by node count and depth, alias and
//   merge resolution by a step budget per file, the duplicate-key scan by node
//   count, and each file's issue list by length.
export const MAX_CHECKED_CHARS = 256_000;
const PARSE_CACHE_SIZE = 4;
const MAX_ISSUES_PER_FILE = 100;
const MAX_SCHEMA_VISITS = 20_000;
const MAX_SCHEMA_DEPTH = 64;
const MAX_RESOLVE_STEPS = 100_000;
const MAX_ALIAS_HOPS = 64;
const MAX_NESTING = 128;
const MAX_KEY_VISITS = 100_000;

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

function nodeRange(node: unknown, fallback: [number, number]): [number, number] {
  const r = (node as YamlNode | null | undefined)?.range;
  return r ? [r[0], r[1]] : fallback;
}

type Parsed = { lc: LineCounter; docs: Document.Parsed[] };

// Read-only once built: nothing below mutates a document or its line counter.
const parseCache = new Map<string, Parsed>();

/** Parse every document, with a line counter to place what goes wrong. */
function parse(text: string): Parsed {
  const hit = parseCache.get(text);
  if (hit) {
    parseCache.delete(text);
    parseCache.set(text, hit);
    return hit;
  }
  const lc = new LineCounter();
  // prettyErrors off: the message is shown beside its line already, and the
  // pretty form appends a copy of the source with a caret under it.
  //
  // uniqueKeys off: quadratic in the keys of a mapping (see the limits above).
  //
  // No `merge: true`. With it the parser treats `<<` as special and a mapping
  // with two of them, which yaml.v3 refuses, stops being two equal keys;
  // merges are resolved below instead.
  const docs = parseAllDocuments(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: false });
  // An empty stream is its own type, iterable but not an array.
  const parsed = { lc, docs: Array.from(docs as Iterable<Document.Parsed>) };
  parseCache.set(text, parsed);
  if (parseCache.size > PARSE_CACHE_SIZE) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  return parsed;
}

/** A `tooLarge` warning for a file not worth freezing the editor over, or null. */
function tooLarge(file: YamlFile, text: string): YamlIssue[] | null {
  if (text.length <= MAX_CHECKED_CHARS) return null;
  const lc = new LineCounter();
  lc.addNewLine(0);
  const out = new Collector(file, lc, text);
  out.add("warning", "tooLarge", [0, 0]);
  return out.issues;
}

const isNullScalar = (node: unknown) =>
  node === null || node === undefined || (isScalar(node) && (node.value === null || node.value === undefined));

// ---------------------------------------------------------------------------
// Syntax

// Lexer tokens that are markers the lexer inserts, not text from the source.
const LEXER_MARKERS = new Set(["doc-mode", "flow-error-end", "scalar"]);
const QUIET_TOKENS = new Set(["space", "newline", "comment", "byte-order-mark", "directive-line"]);

/**
 * An `[` or `{` still open when its document ends, at the bracket.
 *
 * The lexer is used rather than the parser's errors: the parser also fails a
 * flow list that is merely indented less than its key, which yaml.v3 accepts,
 * and reports both at the line where it gave up. The lexer tells quoted and
 * block scalars and comments apart from real brackets, and its depth came out
 * non-zero exactly where yaml.v3 refused.
 */
function unclosedFlowIssues(text: string, out: Collector, firstDocOnly: boolean): boolean {
  let offset = 0;
  let content = false;
  let found = false;
  const open: Array<{ at: number; bracket: string }> = [];
  const flush = () => {
    if (open.length > 0) {
      found = true;
      out.add("error", "unclosedFlow", [open[0].at, open[0].at + 1], { bracket: open[0].bracket });
    }
    open.length = 0;
  };
  for (const tok of new Lexer().lex(text)) {
    const type = CST.tokenType(tok);
    if (type && LEXER_MARKERS.has(type)) continue;
    const at = offset;
    offset += tok.length;
    if (type === "doc-start" || type === "doc-end") {
      if (content || open.length > 0) {
        flush();
        content = false;
        if (firstDocOnly) return found;
      }
      continue;
    }
    if (type === "flow-seq-start" || type === "flow-map-start") {
      open.push({ at, bracket: type === "flow-seq-start" ? "[" : "{" });
    } else if (type === "flow-seq-end" || type === "flow-map-end") {
      open.pop();
    }
    if (!type || !QUIET_TOKENS.has(type)) content = true;
  }
  flush();
  return found;
}

/**
 * A key as yaml.v3 compares it when it refuses a repeated one: node kind and
 * text. A plain key is its source text, a quoted key its value — so `a` and
 * "a" are the same key and `0x1` and `1` are not. The `yaml` parser compares
 * resolved values, which catches the second pair and misses nothing else, so
 * its own duplicate-key error is not the backend's answer.
 */
function keyText(key: unknown, text: string): string | null {
  if (!isScalar(key) || !key.range) return null;
  if (key.type === "PLAIN") {
    const raw = text.slice(key.range[0], key.range[1]);
    return raw.includes("\n") ? null : raw;
  }
  if (key.type === "QUOTE_DOUBLE" || key.type === "QUOTE_SINGLE") {
    return typeof key.value === "string" ? key.value : null;
  }
  return null;
}

/**
 * Repeated keys. `decoded` is the set of mappings yaml.v3 decodes, where a
 * repeat is refused; null means all of them. A repeat anywhere else warns.
 */
function duplicateKeyIssues(doc: Document.Parsed, text: string, out: Collector, decoded: Set<unknown> | null): boolean {
  let visits = 0;
  let found = false;
  visit(doc, (_key, node) => {
    if (++visits > MAX_KEY_VISITS || out.full) return visit.BREAK;
    if (!isMap(node)) return;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const k = keyText(pair.key, text);
      if (k === null) continue;
      if (seen.has(k)) {
        const blocks = decoded === null || decoded.has(node);
        if (blocks) found = true;
        out.add(blocks ? "error" : "warning", "duplicateKey", nodeRange(pair.key, [0, 0]), { key: k });
      } else {
        seen.add(k);
      }
    }
  });
  return found;
}

/** Reports syntax problems; true when the text did not parse cleanly. */
function syntaxIssues(
  docs: Document.Parsed[],
  text: string,
  out: Collector,
  firstDocOnly: boolean,
  decodedMaps: (doc: Document.Parsed) => Set<unknown> | null = () => null,
): boolean {
  const unclosed = unclosedFlowIssues(text, out, firstDocOnly);
  let broken = unclosed;
  for (const doc of docs) {
    if (duplicateKeyIssues(doc, text, out, decodedMaps(doc))) broken = true;
  }
  for (const doc of docs) {
    for (const e of doc.errors) {
      broken = true;
      // Recomputed above the way yaml.v3 decides it.
      if (e.code === "DUPLICATE_KEY") continue;
      // Whatever the parser says after an unclosed bracket is that bracket's
      // echo, a line or more below it.
      if (unclosed) continue;
      out.add("warning", "syntax", e.pos, { detail: e.message });
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Anchors, aliases and merge keys

const UNKNOWN: unique symbol = Symbol("unresolved");
type Unknown = typeof UNKNOWN;

/** A key's value and where to mark it: the value itself, or the alias or merge that brought it. */
type Lookup = { value: unknown; site: unknown };

// yaml.v3 merges on a plain `<<`; a quoted "<<" is an ordinary key (measured).
const isMergeKey = (key: unknown) => isScalar(key) && key.type === "PLAIN" && key.value === "<<";

class Resolver {
  private index = 0;
  private left = MAX_RESOLVE_STEPS;
  private readonly anchorIndex = new Map<number, Map<string, YamlNode[]>>();

  constructor(private readonly docs: Document.Parsed[]) {}

  /** Which document the nodes passed in next belong to. */
  use(index: number): this {
    this.index = index;
    return this;
  }

  get exhausted(): boolean {
    return this.left < 0;
  }

  private tick(): boolean {
    return --this.left >= 0;
  }

  private anchors(j: number): Map<string, YamlNode[]> {
    let found = this.anchorIndex.get(j);
    if (!found) {
      const index = new Map<string, YamlNode[]>();
      visit(this.docs[j], (_key, node) => {
        if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor) {
          const list = index.get(node.anchor) ?? [];
          list.push(node);
          index.set(node.anchor, list);
        }
      });
      this.anchorIndex.set(j, index);
      found = index;
    }
    return found;
  }

  private target(alias: Alias): YamlNode | undefined {
    const at = alias.range?.[0] ?? Number.POSITIVE_INFINITY;
    const here = this.anchors(this.index).get(alias.source) ?? [];
    for (let i = here.length - 1; i >= 0; i--) {
      if ((here[i].range?.[0] ?? Number.POSITIVE_INFINITY) < at) return here[i];
    }
    // yaml.v3's decoder keeps anchors from earlier documents in the stream
    // (measured); the `yaml` library resolves within one document only.
    for (let j = this.index - 1; j >= 0; j--) {
      const list = this.anchors(j).get(alias.source);
      if (list && list.length > 0) return list[list.length - 1];
    }
    return undefined;
  }

  /** Follow aliases to the node they name. */
  deref(node: unknown): unknown {
    let n = node;
    let hops = 0;
    while (isAlias(n)) {
      if (!this.tick() || ++hops > MAX_ALIAS_HOPS) return UNKNOWN;
      n = this.target(n);
      if (n === undefined) return UNKNOWN;
    }
    return n;
  }

  /** A scalar's text as yaml.v3 hands it to a string field; null when absent. */
  text(node: unknown): string | null | Unknown {
    const n = this.deref(node);
    if (n === UNKNOWN) return UNKNOWN;
    if (isNullScalar(n)) return null;
    // A mapping or list where a string belongs is refused by yaml.v3, with a
    // message of its own; saying "no label" about it would be wrong.
    if (!isScalar(n)) return UNKNOWN;
    const v = n.value;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
      return String(v);
    }
    // `!!binary` and friends decode to bytes here and to a string in yaml.v3.
    return UNKNOWN;
  }

  /**
   * A key of a mapping, merge keys included: explicit keys win wherever the
   * merge sits, then merge sources in order, the first that has the key
   * winning — the precedence yaml.v3 applied in every measured case.
   */
  get(map: YAMLMap, key: string, depth = 0): Lookup | undefined | Unknown {
    if (depth > MAX_ALIAS_HOPS || !this.tick()) return UNKNOWN;
    const merges: Pair[] = [];
    for (const pair of map.items) {
      if (isMergeKey(pair.key)) {
        merges.push(pair);
        continue;
      }
      const k = this.deref(pair.key);
      if (k === UNKNOWN) return UNKNOWN;
      if (isScalar(k) && k.value !== null && k.value !== undefined && String(k.value) === key) {
        return { value: pair.value, site: pair.value ?? pair.key };
      }
    }
    for (const merge of merges) {
      const src = this.deref(merge.value);
      const sources = isSeq(src) ? src.items : [src];
      for (const source of sources) {
        const m = this.deref(source);
        // A merge of anything but mappings is refused by yaml.v3, but not a
        // thing to guess a field's value through.
        if (!isMap(m)) return UNKNOWN;
        const hit = this.get(m, key, depth + 1);
        if (hit === UNKNOWN) return UNKNOWN;
        if (hit) return { value: hit.value, site: merge.value ?? merge.key };
      }
    }
    return undefined;
  }

  /** The plain value yaml.v3 decodes a node to, with UNKNOWN where it cannot be told. */
  value(node: unknown, depth = 0): unknown {
    if (!this.tick() || depth > MAX_NESTING) return UNKNOWN;
    const n = this.deref(node);
    if (n === UNKNOWN) return UNKNOWN;
    if (isNullScalar(n)) return null;
    if (isScalar(n)) return n.value;
    if (isSeq(n)) return n.items.map((item) => this.value(item, depth + 1));
    if (!isMap(n)) return UNKNOWN;
    const out: Record<string, unknown> = {};
    const own: Pair[] = [];
    const merged: unknown[] = [];
    for (const pair of n.items) {
      if (isMergeKey(pair.key)) {
        const src = this.deref(pair.value);
        merged.push(...(isSeq(src) ? src.items : [src]));
      } else {
        own.push(pair);
      }
    }
    // Later sources first, so earlier ones overwrite them; explicit keys last.
    for (let i = merged.length - 1; i >= 0; i--) {
      const v = this.value(merged[i], depth + 1);
      if (v === UNKNOWN || v === null || typeof v !== "object" || Array.isArray(v)) return UNKNOWN;
      Object.assign(out, v);
    }
    for (const pair of own) {
      const k = this.deref(pair.key);
      if (!isScalar(k) || k.value === null || k.value === undefined) return UNKNOWN;
      out[String(k.value)] = this.value(pair.value, depth + 1);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// resources.yaml

interface ResourceDoc {
  kind: unknown;
  name: unknown;
  value: Record<string, unknown>;
}

/**
 * Every resource document as yaml.v3 decodes it, or null when that cannot be
 * told — in which case nothing is resolved against them rather than something
 * resolved against the wrong one.
 */
function resourceDocs(docs: Document.Parsed[], r: Resolver): ResourceDoc[] | null {
  const list: ResourceDoc[] = [];
  for (let i = 0; i < docs.length; i++) {
    // A root may be an alias to a mapping anchored in an earlier document,
    // which yaml.v3's streaming decoder resolves (measured).
    const root = r.use(i).deref(docs[i].contents);
    if (root === UNKNOWN) return null;
    if (!isMap(root)) continue;
    const value = r.value(root);
    if (r.exhausted || value === UNKNOWN) return null;
    const obj = value as Record<string, unknown>;
    // parseMultiDoc drops a document that decodes to an empty mapping, which
    // shifts every index selector after it (measured).
    if (Object.keys(obj).length === 0) continue;
    const meta = obj.metadata;
    const name =
      meta === UNKNOWN
        ? UNKNOWN
        : meta && typeof meta === "object" && !Array.isArray(meta)
          ? (meta as Record<string, unknown>).name
          : undefined;
    list.push({ kind: obj.kind, name, value: obj });
  }
  return list;
}

function docKind(
  r: Resolver,
  doc: Document.Parsed,
  index: number,
): { apiVersion: string; kind: string; root: YAMLMap } | null {
  if (doc.errors.length > 0) return null;
  const root = r.use(index).deref(doc.contents);
  if (!isMap(root)) return null;
  const av = r.get(root, "apiVersion");
  const kd = r.get(root, "kind");
  if (!av || av === UNKNOWN || !kd || kd === UNKNOWN) return null;
  const apiVersion = r.text(av.value);
  const kind = r.text(kd.value);
  if (typeof apiVersion !== "string" || typeof kind !== "string" || !apiVersion || !kind) return null;
  return { apiVersion, kind, root };
}

/** apiVersion/kind of each mapping document, for the caller to fetch schemas by. */
export function resourceKinds(resourcesYaml: string): Array<{ apiVersion: string; kind: string }> {
  if (resourcesYaml.length > MAX_CHECKED_CHARS) return [];
  const { docs } = parse(resourcesYaml);
  const r = new Resolver(docs);
  const out: Array<{ apiVersion: string; kind: string }> = [];
  const seen = new Set<string>();
  docs.forEach((doc, i) => {
    const k = docKind(r, doc, i);
    if (!k) return;
    const key = `${k.apiVersion}/${k.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ apiVersion: k.apiVersion, kind: k.kind });
  });
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

// Walks the tree as written. Aliased values and merged keys are not followed:
// these are warnings, and a check that cannot see a value stays quiet about it.
function schemaIssues(root: unknown, schema: SchemaNode, out: Collector) {
  let visits = 0;
  const walk = (node: unknown, s: SchemaNode, path: string, depth: number) => {
    if (out.full || visits++ > MAX_SCHEMA_VISITS || depth > MAX_SCHEMA_DEPTH) return;
    if (isNullScalar(node) || isAlias(node)) return;
    if (ambiguousSchema(s)) return;
    const expected = s.type ?? (s.properties ? "object" : undefined);
    const actual = actualType(node);
    if (!expected || !actual) return;
    if (!compatible(expected, actual)) {
      out.add("warning", "schemaType", nodeRange(node, [0, 0]), {
        path: path || "(root)",
        expected,
        actual,
      });
      return;
    }
    if (isMap(node) && s.properties) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
        const key = pair.key.value;
        const child = s.properties[key];
        if (!child) continue;
        walk(pair.value, child, joinPath(path, key) ?? `${path}.${key}`, depth + 1);
      }
    } else if (isSeq(node) && s.items) {
      node.items.forEach((item, i) => walk(item, s.items!, `${path}[${i}]`, depth + 1));
    }
  };
  walk(root, schema, "", 0);
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
  // A kind or name that could not be resolved might be the one that matches.
  if (docs.some((d) => d.kind === UNKNOWN)) return null;
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
    if (!target) {
      if (ofKind.some((d) => d.name === UNKNOWN)) return null;
      target = ofKind.find((d) => d.name === selector);
    }
  }
  if (!target) {
    if (ofKind.length === 0) return { code: selector ? "resourceNotFound" : "resourceKindMissing", params: { kind, selector } };
    if (selector === "") return { code: "resourceAmbiguous", params: { kind, count: ofKind.length } };
    return { code: "resourceNotFound", params: { kind, selector } };
  }

  let node: unknown = target.value;
  let at = "";
  for (let i = 0; i < keys.length; i++) {
    if (node === UNKNOWN) return null;
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

// The keys of UISpecField (spec.go's Field) — the only entry keys whose
// values yaml.v3 decodes.
const UI_FIELD_KEYS = new Set(["path", "label", "help", "type", "min", "max", "pattern", "values", "default", "required"]);

/**
 * The mappings yaml.v3 decodes when parseSpec reads a ui-spec, which is where a
 * repeated key is refused.
 *
 * It decodes into a struct. A struct's own mapping is checked key by key,
 * unknown keys included, and so is every merge source folded into it; the
 * value of a known key is decoded whole (`default` is `any`); the value of an
 * unknown key is skipped without being looked at. Every case was measured:
 * `x` twice at the root refuses, `unused: {a: 1, a: 2}` saves.
 */
function uiSpecDecodedMaps(doc: Document.Parsed, r: Resolver): Set<unknown> {
  const decoded = new Set<unknown>();
  const walked = new Set<unknown>();
  const structs = new Set<unknown>();

  const whole = (node: unknown, depth: number) => {
    if (depth > MAX_NESTING) return;
    const n = r.deref(node);
    if (!(isMap(n) || isSeq(n)) || walked.has(n)) return;
    walked.add(n);
    if (isMap(n)) {
      decoded.add(n);
      for (const pair of n.items) whole(pair.value, depth + 1);
    } else {
      for (const item of n.items) whole(item, depth + 1);
    }
  };

  const struct = (node: unknown, onKey: (key: string, value: unknown, depth: number) => void, depth: number) => {
    if (depth > MAX_NESTING) return;
    const n = r.deref(node);
    if (!isMap(n) || structs.has(n)) return;
    structs.add(n);
    decoded.add(n);
    for (const pair of n.items) {
      if (isMergeKey(pair.key)) {
        const src = r.deref(pair.value);
        for (const source of isSeq(src) ? src.items : [src]) struct(source, onKey, depth + 1);
        continue;
      }
      const key = r.text(pair.key);
      if (typeof key === "string") onKey(key, pair.value, depth + 1);
    }
  };

  const entryKey = (key: string, value: unknown, depth: number) => {
    if (UI_FIELD_KEYS.has(key)) whole(value, depth);
  };
  const rootKey = (key: string, value: unknown, depth: number) => {
    if (key !== "fields") return;
    const list = r.deref(value);
    if (isSeq(list)) for (const item of list.items) struct(item, entryKey, depth + 1);
  };

  r.use(0);
  struct(doc.contents, rootKey, 0);
  return decoded;
}

function uiSpecIssuesAt(doc: Document.Parsed, r: Resolver, resources: ResourceDoc[] | null, out: Collector) {
  r.use(0);
  const root = r.deref(doc.contents);
  if (root === UNKNOWN || isNullScalar(root)) return;
  if (!isMap(root)) {
    out.add("error", "uiSpecNotMapping", nodeRange(root, doc.range ? [doc.range[0], doc.range[1]] : [0, 0]));
    return;
  }
  const fieldsAt = r.get(root, "fields");
  if (fieldsAt === UNKNOWN || !fieldsAt) return;
  const fields = r.deref(fieldsAt.value);
  if (fields === UNKNOWN || isNullScalar(fields)) return;
  if (!isSeq(fields)) {
    out.add("error", "fieldsNotList", nodeRange(fieldsAt.site, [0, 0]));
    return;
  }
  fields.items.forEach((item, index) => {
    if (out.full) return;
    const itemRange = nodeRange(item, nodeRange(fieldsAt.site, [0, 0]));
    const entry = r.deref(item);
    // yaml.v3 saves a null entry (measured).
    if (entry === UNKNOWN || isNullScalar(entry)) return;
    if (!isMap(entry)) {
      out.add("error", "fieldNotMapping", itemRange, { index });
      return;
    }
    // Only the first character of the entry when a key is missing: a
    // whole-mapping range would underline every setting.
    const headRange: [number, number] = [itemRange[0], itemRange[0]];
    const read = (key: string): { text: string | null; range: [number, number] } | Unknown => {
      const hit = r.get(entry, key);
      if (hit === UNKNOWN) return UNKNOWN;
      if (!hit) return { text: null, range: headRange };
      const text = r.text(hit.value);
      if (text === UNKNOWN) return UNKNOWN;
      return { text, range: nodeRange(hit.site, headRange) };
    };

    // Same order as ValidateSpec: type, label, path — one error per field.
    const type = read("type");
    if (type === UNKNOWN) return;
    if (!KNOWN_TYPES.has(type.text ?? "")) {
      out.add("error", "unknownType", type.range, { index, type: type.text ?? "" });
      return;
    }
    const label = read("label");
    if (label === UNKNOWN) return;
    if ((label.text ?? "").trim() === "") {
      out.add("error", "missingLabel", label.range, { index });
      return;
    }
    const pathRead = read("path");
    if (pathRead === UNKNOWN) return;
    const { text: path, range: pathRange } = pathRead;
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

function checkResources(text: string, schemaFor?: SchemaLookup): { issues: YamlIssue[]; docs: ResourceDoc[] | null } {
  const big = tooLarge("resources", text);
  if (big) return { issues: big, docs: null };
  const res = parse(text);
  const out = new Collector("resources", res.lc, text);
  // A document that did not parse cleanly is not resolved or type-checked:
  // whatever the parser recovered is a guess.
  const broken = syntaxIssues(res.docs, text, out, false);
  if (!broken) {
    const shapes = new Resolver(res.docs);
    res.docs.forEach((doc, i) => {
      // Resolved first: a root alias to a mapping in an earlier document is a
      // mapping to yaml.v3 (measured).
      const c = shapes.use(i).deref(doc.contents);
      // An anchor that cannot be found is refused by yaml.v3, but there is no
      // shape to judge. An empty document — a bare `---`, only comments, or an
      // alias to null — decodes to an empty map in the backend and is dropped.
      if (c === UNKNOWN || isNullScalar(c)) return;
      if (!isMap(c)) {
        out.add("error", "documentNotMapping", nodeRange(doc.contents, [0, 0]), { found: isSeq(c) ? "list" : "scalar" });
      }
    });
  }
  const docs = broken ? null : resourceDocs(res.docs, new Resolver(res.docs));
  if (schemaFor && !broken) {
    const kinds = new Resolver(res.docs);
    // Two documents can share one root through an alias; check it once.
    const walked = new Set<unknown>();
    res.docs.forEach((doc, i) => {
      const k = docKind(kinds, doc, i);
      if (!k || walked.has(k.root)) return;
      walked.add(k.root);
      const schema = schemaFor(k.apiVersion, k.kind);
      if (schema) schemaIssues(k.root, schema, out);
    });
  }
  return { issues: out.issues, docs };
}

function checkUiSpec(text: string, resources: ResourceDoc[] | null): YamlIssue[] {
  const big = tooLarge("uiSpec", text);
  if (big) return big;
  // yaml.Unmarshal reads the first document of ui-spec.yaml and nothing else.
  const spec = parse(text);
  const out = new Collector("uiSpec", spec.lc, text);
  const first = spec.docs.slice(0, 1);
  const decodedMaps = (doc: Document.Parsed) => uiSpecDecodedMaps(doc, new Resolver([doc]));
  if (!syntaxIssues(first, text, out, true, decodedMaps) && first[0]) {
    // Resolution needs resources that parse; until then only the path's own
    // grammar is checked.
    uiSpecIssuesAt(first[0], new Resolver(first), resources, out);
  }
  return out.issues;
}

export function validateTemplateYaml(
  resourcesYaml: string,
  uiSpecYaml: string,
  schemaFor?: SchemaLookup,
): TemplateYamlValidation {
  const resources = checkResources(resourcesYaml, schemaFor);
  return { resources: resources.issues, uiSpec: checkUiSpec(uiSpecYaml, resources.docs) };
}

export function errorCount(v: TemplateYamlValidation): number {
  return [...v.resources, ...v.uiSpec].filter((i) => i.severity === "error").length;
}

export function firstError(v: TemplateYamlValidation): YamlIssue | undefined {
  return v.resources.find((i) => i.severity === "error") ?? v.uiSpec.find((i) => i.severity === "error");
}
