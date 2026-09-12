// What is wrong with a YAML-mode template, located to line and column (#181).
//
// YAML mode handed the admin two bare Monaco editors: a broken bracket, a
// string where Kubernetes wants an integer, or a ui-spec path pointing at a
// resource that had just been renamed all looked exactly like a correct
// template until the save came back 400 — or, for the last two, until a user's
// deploy failed.
//
// The rule is one-sided: never refuse a save the backend would accept. Only
// errors block save, so an error is only what this file can be sure
// gopkg.in/yaml.v3 and ValidateSpec (backend/internal/template/render.go)
// refuse, and every kind below was run through the real backend. Wherever this
// model and yaml.v3 can still disagree, the model must err towards a missed
// block — a warning, or nothing — and never towards a false one.
//
// Two layers hold that line.
//
// Per file, a structural guard. The checks model plain YAML closely and
// yaml.v3's handling of everything else only case by case, and three rounds of
// review kept finding more cases. So in a file that uses any of these, every
// problem is still shown but none blocks save:
//   - a tag (`!x`, `!!str`, `!<…>`)
//   - an anchor or an alias
//   - a merge key (`<<`, plain or tagged)
//   - a `%` directive
//   - in ui-spec.yaml only, more than one `---`, or any `...`
// resources.yaml may hold many documents: that is ordinary and modelled.
//
// Per check, in a file the guard lets through:
//   error    An `[` or `{` still open when its document ends ("did not find
//            expected ',' or ']'"), and flow nesting deeper than 10000
//            ("exceeded max depth of 10000"). yaml.v3 limits block nesting too,
//            but only flow depth can be counted from lexer tokens, so deep block
//            nesting is left to the save.
//            A key repeated in a mapping yaml.v3 decodes, compared as it compares
//            keys — by text, so `a` and "a" collide while `0x1` and `1` do not.
//            That is every mapping in resources.yaml, but in ui-spec.yaml only
//            the root, the field entries (merge sources included) and the values
//            of their known keys. An unknown key's value is never decoded, so a
//            repeat inside one is a warning. So is any repeat in a document the
//            `yaml` parser could not read cleanly: its tree is a recovery guess.
//            A resource document that is not a mapping; a ui-spec that is not
//            `fields: [mapping…]`; an unknown field type; a blank label (blank
//            as Go's strings.TrimSpace sees it); a path that does not parse, is
//            not canonical, selects a whole resource or sets a reserved field.
//   warning  Anything else the `yaml` parser complains about. It is stricter
//            than yaml.v3: a `#` with no space before it, a lone CR or U+2028
//            as a line break, and a flow list continued on a line indented
//            less than its key all fail there and save fine. (The last one the
//            `yaml` lexer abandons mid-list and reads the rest as plain text,
//            closing bracket included; scanTokens counts brackets in that text
//            so the list is not reported open.)
//            A path whose resource is missing, and a value whose type does not
//            match the cluster's OpenAPI schema: ValidateSpec never looks, the
//            save succeeds, and a deploy trips over them later.
//
// That is a subset of ValidateSpec, not all of it. An invalid `pattern`, a
// non-integer `min`/`max` and a non-boolean `required` pass here and are
// refused by the save itself, whose 400 message the editor shows. Pattern
// rules belong to ui-spec-to-zod, where RE2 and JavaScript regexes differ.
//
// Anchors, aliases and merge keys are still resolved the way yaml.v3 resolves
// them, so the warnings and markers in a guarded file point at the right
// thing. When resolution cannot finish — an unknown anchor, a merge of a
// scalar, a spent budget — that check is skipped, not guessed.
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
  "advisoryOnly",
  "tooLarge",
  "tooDeep",
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
//   `tooLarge` warning and the save's own validation. Real templates are a few
//   KB; at this size an error-dense file still parses in about half a second.
//   Moving the check to a Web Worker would lift the limit, and is not done.
// - Depth. Flow nesting past yaml.v3's own limit is refused before parsing:
//   the `yaml` parser holds hundreds of megabytes for such a text.
// - The parse. The `yaml` parser's duplicate-key check compares each key with
//   every earlier key of its mapping — a 20k-key ConfigMap took 22s — so it
//   runs with `uniqueKeys: false`, and duplicateKeyIssues does that job with a
//   Set per mapping.
// - Repetition. Only the latest text of each file is kept, lexed and parsed
//   once, so the debounced check, resourceKinds and the save handler's re-check
//   of unchanged text share it — and an old text is never retained.
// - The walks after it: anchors are found by binary search in one index per
//   stream, alias and merge resolution runs on a step budget per file, the
//   schema walk is cut off by node count and depth, the duplicate-key scan by
//   node count, and each file's issue list by length.
export const MAX_CHECKED_CHARS = 64_000;
// gopkg.in/yaml.v3's max_flow_level and max_indents: 10000 accepted, 10001 not.
const MAX_BACKEND_DEPTH = 10_000;
const MAX_ISSUES_PER_FILE = 100;
const MAX_SCHEMA_VISITS = 20_000;
const MAX_SCHEMA_DEPTH = 64;
const MAX_RESOLVE_STEPS = 100_000;
const MAX_ALIAS_HOPS = 64;
const MAX_NESTING = 128;
const MAX_KEY_VISITS = 100_000;

const MERGE_TAG = "tag:yaml.org,2002:merge";

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

  make(severity: YamlIssueSeverity, code: YamlIssueCode, at: [number, number], params: YamlIssue["params"] = {}): YamlIssue {
    return { file: this.file, severity, code, params, ...this.range(at) };
  }

  add(severity: YamlIssueSeverity, code: YamlIssueCode, at: [number, number], params: YamlIssue["params"] = {}) {
    if (this.full) return;
    this.issues.push(this.make(severity, code, at, params));
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

/** A line counter for a text that is not parsed. */
function lineCounterFor(text: string): LineCounter {
  const lc = new LineCounter();
  lc.addNewLine(0);
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lc.addNewLine(i + 1);
  }
  return lc;
}

const isNullScalar = (node: unknown) =>
  node === null || node === undefined || (isScalar(node) && (node.value === null || node.value === undefined));

// Go's strings.TrimSpace, which ValidateSpec uses on a label: unicode.IsSpace.
// Not String.prototype.trim — that also strips U+FEFF, and a label of a lone
// BOM saves (measured).
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, "g");
const goTrimSpace = (s: string) => s.replace(GO_TRIM, "");

// ---------------------------------------------------------------------------
// Lexing: brackets, depth, document boundaries and the structural guard

type GuardConstruct = "tag" | "anchor" | "alias" | "merge" | "directive" | "documents";
interface Guard {
  construct: GuardConstruct;
  at: number;
}

interface Scan {
  /** The first bracket left open in each document the backend reads. */
  unclosed: Array<{ at: number; bracket: string }>;
  /** Where flow nesting first passed MAX_BACKEND_DEPTH in a document the backend reads. */
  tooDeep: number | null;
  /** Flow nesting past the limit in a document the backend does not read. */
  deepUnread: boolean;
  /** The first construct the checks do not model precisely, seen by the lexer. */
  guard: Guard | null;
}

const QUIET_TOKENS = new Set(["space", "newline", "comment", "byte-order-mark", "directive-line"]);

// yaml.v3 breaks lines on a lone CR, NEL, LS and PS as well as LF; the `yaml`
// lexer only on LF, so a comment there swallows the rest of the line — `]`
// included (measured: `[b # c\u2028]` saves). Each is one UTF-16 unit, so
// offsets are unchanged. CRLF is a break to both and is left alone.
const ODD_BREAKS = /\r(?!\n)|[\u0085\u2028\u2029]/g;

/**
 * One pass of the `yaml` lexer over the text.
 *
 * It answers the questions that must not depend on the parser's recovery:
 * which brackets are left open, how deep flow nesting goes, where documents
 * end, and whether the file uses a construct the guard downgrades for.
 *
 * `readsAllDocuments` is false for ui-spec.yaml, which yaml.Unmarshal reads
 * only the first document of — even when that document is empty, as in
 * `---\n---\nx: [` (measured). Document boundaries are therefore tracked from
 * the markers themselves, not from whether content was seen.
 */
function scanTokens(source: string, readsAllDocuments: boolean): Scan {
  const text = source.replace(ODD_BREAKS, "\n");
  const scan: Scan = { unclosed: [], tooDeep: null, deepUnread: false, guard: null };
  const open: Array<{ at: number; bracket: string }> = [];
  let offset = 0;
  let docIndex = 0;
  let docStarts = 0;
  let started = false;
  let scalarNext = false;
  let blockBodyNext = false;
  let recovering = false;
  let tagEnd = -1;

  const reads = () => readsAllDocuments || docIndex === 0;
  const trigger = (construct: GuardConstruct, at: number) => {
    scan.guard ??= { construct, at };
  };
  const push = (at: number, bracket: string) => {
    open.push({ at, bracket });
    if (open.length > MAX_BACKEND_DEPTH) {
      if (!reads()) scan.deepUnread = true;
      else scan.tooDeep ??= at;
    }
  };
  const pop = () => {
    open.pop();
    if (open.length === 0) recovering = false;
  };
  const endDocument = () => {
    if (reads() && open.length > 0) scan.unclosed.push(open[0]);
    open.length = 0;
    recovering = false;
    started = false;
    docIndex++;
  };

  for (const tok of new Lexer().lex(text)) {
    const type = CST.tokenType(tok);
    // Markers the lexer inserts, not source text.
    if (type === "doc-mode") continue;
    if (type === "scalar") {
      scalarNext = true;
      continue;
    }
    if (type === "flow-error-end") {
      // The lexer gave up on a flow collection — typically one continued on a
      // line indented less than its key, which yaml.v3 allows — and reads the
      // rest in block mode, where a closing bracket is just a character of a
      // plain scalar.
      if (open.length > 0) recovering = true;
      continue;
    }
    const at = offset;
    offset += tok.length;

    if (scalarNext) {
      scalarNext = false;
      started = true;
      const blockBody = blockBodyNext;
      blockBodyNext = false;
      // In yaml.v3's flow context a plain scalar cannot contain a bracket, so
      // every bracket in recovered plain text is structure there. A block
      // scalar's body is text either way and is never counted.
      if (recovering && !blockBody && open.length > 0) {
        for (let i = 0; i < tok.length; i++) {
          const c = tok[i];
          if (c === "[" || c === "{") push(at + i, c);
          else if ((c === "]" || c === "}") && open.length > 0) pop();
        }
      }
      continue;
    }

    switch (type) {
      case "doc-start":
        docStarts++;
        if (!readsAllDocuments && docStarts > 1) trigger("documents", at);
        // A second `---` ends the document before it even when that one was
        // empty.
        if (started || open.length > 0) endDocument();
        started = true;
        continue;
      case "doc-end":
        if (!readsAllDocuments) trigger("documents", at);
        endDocument();
        continue;
      case "directive-line":
        trigger("directive", at);
        continue;
      case "tag":
        trigger("tag", at);
        tagEnd = at + tok.length;
        break;
      case "anchor":
        trigger("anchor", at);
        break;
      case "alias":
        trigger("alias", at);
        break;
      case "block-scalar-header":
        blockBodyNext = true;
        break;
      case "flow-seq-start":
      case "flow-map-start":
        // `!x[` is one tag to yaml.v3, whose tag URIs may hold brackets.
        if (at !== tagEnd) push(at, tok);
        break;
      case "flow-seq-end":
      case "flow-map-end":
        if (open.length > 0) pop();
        break;
    }
    if (!type || !QUIET_TOKENS.has(type)) started = true;
  }
  endDocument();
  return scan;
}

// ---------------------------------------------------------------------------
// Parsing, cached per file

type Parsed = { lc: LineCounter; docs: Document.Parsed[] };
type Analysis = { text: string; scan?: Scan; parsed?: Parsed };

// The latest text of each file and what was learnt from it. One entry per file
// rather than a few texts per cache: a pathological text is held only until
// the next edit. Read-only once built — nothing below mutates a document.
const latest = new Map<YamlFile, Analysis>();

function analysis(file: YamlFile, text: string): Analysis {
  const hit = latest.get(file);
  if (hit && hit.text === text) return hit;
  const fresh: Analysis = { text };
  latest.set(file, fresh);
  return fresh;
}

function scanOf(file: YamlFile, text: string): Scan {
  const a = analysis(file, text);
  return (a.scan ??= scanTokens(text, file === "resources"));
}

/** Parse every document, with a line counter to place what goes wrong. */
function parseOf(file: YamlFile, text: string): Parsed {
  const a = analysis(file, text);
  if (!a.parsed) {
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
    a.parsed = { lc, docs: Array.from(docs as Iterable<Document.Parsed>) };
  }
  return a.parsed;
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

/** A merge key anywhere — the one guarded construct the lexer cannot see. */
function mergeGuard(docs: Document.Parsed[]): Guard | null {
  let visits = 0;
  let found: Guard | null = null;
  for (const doc of docs) {
    visit(doc, (_key, node) => {
      if (++visits > MAX_KEY_VISITS) return visit.BREAK;
      if (!isMap(node)) return;
      for (const pair of node.items) {
        const k = pair.key;
        if (isScalar(k) && (k.value === "<<" || k.tag === MERGE_TAG)) {
          found = { construct: "merge", at: k.range?.[0] ?? 0 };
          return visit.BREAK;
        }
      }
    });
    if (found) return found;
  }
  return null;
}

/** Downgrade every error in a guarded file, and say why first. */
function guarded(out: Collector, guard: Guard | null): YamlIssue[] {
  if (!guard) return out.issues;
  for (const issue of out.issues) issue.severity = "warning";
  const why = out.make("warning", "advisoryOnly", [guard.at, guard.at + 1], { construct: guard.construct });
  return [why, ...out.issues];
}

// ---------------------------------------------------------------------------
// Syntax

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

const NOTHING_DECODED: Set<unknown> = new Set();

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
  scan: Scan,
  decodedMaps: (doc: Document.Parsed) => Set<unknown> | null = () => null,
): boolean {
  for (const u of scan.unclosed) out.add("error", "unclosedFlow", [u.at, u.at + 1], { bracket: u.bracket });
  const unclosed = scan.unclosed.length > 0;
  let broken = unclosed;
  for (const doc of docs) {
    // A document the parser could not read cleanly is its recovery guess: a
    // flow list the lexer abandoned can turn `"b": 2` inside it into a second
    // top-level `b` (`b: 1\nx: [\n"b": 2]` saves). A repeat there only warns.
    const decoded = doc.errors.length > 0 ? NOTHING_DECODED : decodedMaps(doc);
    if (duplicateKeyIssues(doc, text, out, decoded)) broken = true;
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

type AnchorEntry = { doc: number; start: number; node: YamlNode };

class Resolver {
  private index = 0;
  private left = MAX_RESOLVE_STEPS;
  private anchorIndex: Map<string, AnchorEntry[]> | null = null;

  constructor(
    private readonly docs: Document.Parsed[],
    private readonly text: string,
  ) {}

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

  /**
   * Whether yaml.v3 merges on this key (measured): `<<` plain, or under the
   * merge tag in any quoting (`!!merge '<<'`, `!<tag:yaml.org,2002:merge> <<`),
   * or plain under the non-specific `!`. A quoted "<<" with no tag,
   * `!!str <<` and `!!merge foo` are ordinary keys.
   */
  isMerge(key: unknown): boolean {
    if (!isScalar(key) || !key.range) return false;
    const raw = this.text.slice(key.range[0], key.range[1]);
    const quoted = key.type === "QUOTE_SINGLE" || key.type === "QUOTE_DOUBLE";
    if ((quoted ? raw.slice(1, -1) : raw) !== "<<") return false;
    if (key.tag === MERGE_TAG) return true;
    return !quoted && (key.tag === undefined || key.tag === "!");
  }

  /** Every anchor in the stream, in document order: one pass, then binary search. */
  private anchors(): Map<string, AnchorEntry[]> {
    if (!this.anchorIndex) {
      const byName = new Map<string, AnchorEntry[]>();
      this.docs.forEach((d, doc) => {
        visit(d, (_key, node) => {
          if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor) {
            const list = byName.get(node.anchor) ?? [];
            list.push({ doc, start: node.range?.[0] ?? 0, node });
            byName.set(node.anchor, list);
          }
        });
      });
      this.anchorIndex = byName;
    }
    return this.anchorIndex;
  }

  /**
   * The last anchor of this name before the alias. yaml.v3's decoder keeps
   * anchors from earlier documents in the stream (measured), so "before" spans
   * documents; the `yaml` library resolves within one document only.
   */
  private target(alias: Alias): YamlNode | undefined {
    const list = this.anchors().get(alias.source);
    if (!list) return undefined;
    const at = alias.range?.[0] ?? Number.POSITIVE_INFINITY;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = list[mid];
      if (e.doc < this.index || (e.doc === this.index && e.start < at)) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? list[lo - 1].node : undefined;
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
  textOf(node: unknown): string | null | Unknown {
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
      if (this.isMerge(pair.key)) {
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
      if (this.isMerge(pair.key)) {
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
  const apiVersion = r.textOf(av.value);
  const kind = r.textOf(kd.value);
  if (typeof apiVersion !== "string" || typeof kind !== "string" || !apiVersion || !kind) return null;
  return { apiVersion, kind, root };
}

/** apiVersion/kind of each mapping document, for the caller to fetch schemas by. */
export function resourceKinds(resourcesYaml: string): Array<{ apiVersion: string; kind: string }> {
  if (resourcesYaml.length > MAX_CHECKED_CHARS) return [];
  if (scanOf("resources", resourcesYaml).tooDeep !== null) return [];
  const { docs } = parseOf("resources", resourcesYaml);
  const r = new Resolver(docs, resourcesYaml);
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
      if (r.isMerge(pair.key)) {
        const src = r.deref(pair.value);
        for (const source of isSeq(src) ? src.items : [src]) struct(source, onKey, depth + 1);
        continue;
      }
      const key = r.textOf(pair.key);
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
      const text = r.textOf(hit.value);
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
    if (goTrimSpace(label.text ?? "") === "") {
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
  const scan = scanOf("resources", text);
  if (scan.tooDeep !== null) {
    // Not parsed: the backend refuses the file, and the parse is what costs.
    const out = new Collector("resources", lineCounterFor(text), text);
    out.add("error", "tooDeep", [scan.tooDeep, scan.tooDeep + 1]);
    return { issues: guarded(out, scan.guard), docs: null };
  }
  const res = parseOf("resources", text);
  const out = new Collector("resources", res.lc, text);
  // A document that did not parse cleanly is not resolved or type-checked:
  // whatever the parser recovered is a guess.
  const broken = syntaxIssues(res.docs, text, out, scan);
  if (!broken) {
    const shapes = new Resolver(res.docs, text);
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
  const docs = broken ? null : resourceDocs(res.docs, new Resolver(res.docs, text));
  if (schemaFor && !broken) {
    const kinds = new Resolver(res.docs, text);
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
  return { issues: guarded(out, scan.guard ?? mergeGuard(res.docs)), docs };
}

function checkUiSpec(text: string, resources: ResourceDoc[] | null): YamlIssue[] {
  const big = tooLarge("uiSpec", text);
  if (big) return big;
  const scan = scanOf("uiSpec", text);
  if (scan.tooDeep !== null) {
    const out = new Collector("uiSpec", lineCounterFor(text), text);
    out.add("error", "tooDeep", [scan.tooDeep, scan.tooDeep + 1]);
    return guarded(out, scan.guard);
  }
  if (scan.deepUnread) {
    // Too deep to parse, in a document yaml.Unmarshal never reads: nothing to
    // refuse, and the parse is not worth its memory.
    const out = new Collector("uiSpec", lineCounterFor(text), text);
    out.add("warning", "tooLarge", [0, 0]);
    return guarded(out, scan.guard);
  }
  // yaml.Unmarshal reads the first document of ui-spec.yaml and nothing else.
  const spec = parseOf("uiSpec", text);
  const out = new Collector("uiSpec", spec.lc, text);
  const first = spec.docs.slice(0, 1);
  const decodedMaps = (doc: Document.Parsed) => uiSpecDecodedMaps(doc, new Resolver([doc], text));
  if (!syntaxIssues(first, text, out, scan, decodedMaps) && first[0]) {
    // Resolution needs resources that parse; until then only the path's own
    // grammar is checked.
    uiSpecIssuesAt(first[0], new Resolver(first, text), resources, out);
  }
  return guarded(out, scan.guard ?? mergeGuard(spec.docs));
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
