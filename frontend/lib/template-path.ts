// The template path grammar, in one place.
//
//   path     ::= Kind [ "[" selector "]" ] ( "." ? segment )*
//   selector ::= INT | NAME            (a metadata.name, or an index)
//   segment  ::= NAME | "[" INT "]" | "[" QUOTED "]"
//   NAME     ::= [A-Za-z_][A-Za-z0-9_]*
//   QUOTED   ::= '"' [^"]* '"' | "'" [^']* "'"
//
// Mirrors backend/internal/template/jsonpath.go. Keep the two in step: the
// backend parses what this file's callers generate.
//
// NAME does not cover `.`, `-` or `/`, all of which are legal in a Kubernetes
// map key. Widening it cannot help, because `.` is this grammar's separator —
// `metadata.labels.app.kubernetes.io/name` is genuinely ambiguous between one
// key and four. QUOTED is how a caller says which, and it is why
// `app.kubernetes.io/name` is addressable at all (issue #129).
//
// There is no escape character. A key containing one quote style is written
// with the other; Kubernetes keys can contain neither.

const PLAIN_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const plainSegmentHead = /^[A-Za-z_][A-Za-z0-9_]*/;

// Mirrors maxPathDepth in jsonpath.go, where it is a denial-of-service limit:
// the backend builds a document from these paths, and depth costs it
// quadratically (the YAML encoder indents). Here it is only about staying in
// step — a path this side accepts and the backend refuses would surface as an
// unexplained 400 on save, a long way from the document that caused it.
// Real manifests run about nine segments deep.
const MAX_PATH_DEPTH = 128;

// The selector cannot open with a quote (it is an index or a DNS-1123 name),
// which is what keeps `Kind["some.key"]` from being read as a resource
// selector rather than a quoted first segment.
const headRE = /^([A-Z][A-Za-z]+)(?:\[([^"'\]][^\]]*)\])?(.*)$/;

/**
 * Whether key can be written as a path segment at all.
 *
 * With no escape character a key is quoted with whichever style it does not
 * contain, so a key holding BOTH is unrepresentable. Kubernetes keys can hold
 * neither, but ConfigMap data keys and CRD fields are unconstrained.
 */
export function addressable(key: string): boolean {
  return !key.includes('"') || !key.includes("'");
}

/**
 * Render one map key as a path segment, quoting it only when it must be.
 * Returns null for a key `addressable` rejects — emitting a path that parses
 * as something else would surface far from the key that caused it.
 */
export function formatSegment(key: string): string | null {
  if (PLAIN_SEGMENT.test(key)) return key;
  if (!addressable(key)) return null;
  const quote = key.includes('"') ? "'" : '"';
  return `[${quote}${key}${quote}]`;
}

/** Join a leading path with a map key, quoting the key when necessary. */
export function joinPath(prefix: string, key: string): string | null {
  const seg = formatSegment(key);
  if (seg === null) return null;
  if (!prefix) return seg;
  // A bracketed segment is self-delimiting, so no separating dot.
  return seg.startsWith("[") ? prefix + seg : `${prefix}.${seg}`;
}

/**
 * Tokenize the segment list after `Kind[selector]`. Returns null on anything
 * malformed — callers treat an unparseable path as "leave the document alone",
 * which is only safe if this never guesses.
 */
export function parsePathSegments(path: string): (string | number)[] | null {
  const keys: (string | number)[] = [];
  let rest = path;
  while (rest !== "") {
    if (keys.length >= MAX_PATH_DEPTH) return null;
    if (rest.startsWith("[")) {
      const quote = rest[1];
      if (quote === '"' || quote === "'") {
        const end = rest.indexOf(quote, 2);
        if (end < 0) return null;
        if (rest[end + 1] !== "]") return null;
        keys.push(rest.slice(2, end));
        rest = rest.slice(end + 2);
      } else {
        const end = rest.indexOf("]");
        if (end < 0) return null;
        const body = rest.slice(1, end);
        // Only non-negative decimal digits: `[-1]` and `[1e3]` would survive
        // Number() and then index out of bounds or address nothing.
        if (!/^\d+$/.test(body)) return null;
        keys.push(Number(body));
        rest = rest.slice(end + 1);
      }
    } else {
      const m = plainSegmentHead.exec(rest);
      if (!m) return null;
      keys.push(m[0]);
      rest = rest.slice(m[0].length);
    }
    if (rest.startsWith(".")) rest = rest.slice(1);
  }
  return keys;
}

/** Render parsed segments back as a path, in the one canonical spelling. */
export function formatPath(keys: (string | number)[]): string | null {
  let out = "";
  for (const k of keys) {
    if (typeof k === "number") {
      out = `${out}[${k}]`;
      continue;
    }
    const next = joinPath(out, k);
    if (next === null) return null;
    out = next;
  }
  return out;
}

/**
 * Re-spell a path in the canonical form, or null if it does not parse.
 *
 * The parser accepts spellings the generator never emits — `['a']` for
 * `["a"]`, `["replicas"]` for `replicas` — which is right for input but wrong
 * for a map key. yaml-to-ui-state indexes fields BY path, so an equivalent
 * spelling used to create a second entry beside the generated one; both then
 * described the same YAML key and SerializeUIMode wrote whichever Go's map
 * iteration reached last.
 */
export function canonicalizePath(path: string): string | null {
  const keys = parsePathSegments(path);
  return keys === null ? null : formatPath(keys);
}

/**
 * Split `Kind[selector].rest` into its head and the rest AS TEXT.
 *
 * The tail is returned unparsed because callers key maps by it; re-assembling
 * it from segments would silently canonicalize, and whether to canonicalize is
 * the caller's decision to make explicitly.
 */
export function splitHead(path: string): { kind: string; selector: string; rest: string } | null {
  const m = headRE.exec(path);
  if (!m) return null;
  const [, kind, selector = "", tail] = m;
  return { kind, selector, rest: tail.startsWith(".") ? tail.slice(1) : tail };
}

export interface TemplatePath {
  kind: string;
  selector: string;
  keys: (string | number)[];
}

/** Parse a full `Kind[selector].a.b[0]` path. Returns null when malformed. */
export function parseTemplatePath(path: string): TemplatePath | null {
  const m = headRE.exec(path);
  if (!m) return null;
  const [, kind, selector = "", tail] = m;
  const keys = parsePathSegments(tail.startsWith(".") ? tail.slice(1) : tail);
  if (keys === null) return null;
  return { kind, selector, keys };
}
