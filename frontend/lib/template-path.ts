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

// The selector cannot open with a quote (it is an index or a DNS-1123 name),
// which is what keeps `Kind["some.key"]` from being read as a resource
// selector rather than a quoted first segment.
const headRE = /^([A-Z][A-Za-z]+)(?:\[([^"'\]][^\]]*)\])?(.*)$/;

/** Render one map key as a path segment, quoting it only when it must be. */
export function formatSegment(key: string): string {
  if (PLAIN_SEGMENT.test(key)) return key;
  const quote = key.includes('"') ? "'" : '"';
  return `[${quote}${key}${quote}]`;
}

/** Join a leading path with a map key, quoting the key when necessary. */
export function joinPath(prefix: string, key: string): string {
  const seg = formatSegment(key);
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
