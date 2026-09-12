import { parseAllDocuments, type Document } from "yaml";

import { parseTemplatePath } from "./template-path";

// Client-side mirror of the backend's template.Render path injection
// (backend/internal/template/jsonpath.go), used by the landing-page
// comparison so the "admin YAML" pane reacts to the "user form" pane without
// a server round-trip. Deliberately narrower than the backend: unknown
// documents or paths are ignored instead of auto-created, because this is a
// display aid, not the deploy path.
//
// The grammar itself lives in ./template-path — it used to be a second copy of
// the regexes here, which is how issue #129's bug came to exist in three
// places at once.

function findDoc(docs: Document[], kind: string, selector: string): Document | null {
  const matches = docs.filter((d) => d.get("kind") === kind);
  if (selector === "") return matches.length === 1 ? matches[0] : null;
  if (/^\d+$/.test(selector)) return matches[Number(selector)] ?? null;
  return matches.find((d) => d.getIn(["metadata", "name"]) === selector) ?? null;
}

/**
 * Apply flat `{ path: value }` pairs to a multi-document YAML string and
 * return the re-serialized text. Comments and document order survive; the
 * output formatting is the `yaml` library's, so apply it once with `{}` to get
 * a comparable baseline before diffing.
 */
export function applyValuesToYaml(resourcesYaml: string, values: Record<string, unknown>): string {
  const docs = parseAllDocuments(resourcesYaml);
  for (const [p, v] of Object.entries(values)) {
    // null is how the form holds "no value" (#316 #327). The deploy path
    // leaves such a key out, so the template keeps its own value here too.
    if (v === undefined || v === null) continue;
    const parsed = parseTemplatePath(p);
    if (!parsed || parsed.keys.length === 0) continue;
    const doc = findDoc(docs, parsed.kind, parsed.selector);
    if (!doc || !doc.hasIn(parsed.keys)) continue;
    doc.setIn(parsed.keys, v);
  }
  // Documents after the first remember their own `---` marker and emit it in
  // toString(); strip it so the join below is the only separator and the
  // output is stable under re-parsing.
  return docs.map((d) => d.toString().replace(/^---\n/, "")).join("---\n");
}

/**
 * Inclusive zero-based line span of `next` that differs from `prev`, or null
 * when identical. Trims the common prefix and suffix, so a single scalar edit
 * yields a one-line span and an inserted block yields exactly that block.
 */
export function changedLineRange(prev: string, next: string): [number, number] | null {
  if (prev === next) return null;
  const a = prev.split("\n");
  const b = next.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const end = b.length - 1 - tail;
  return [head, Math.max(head, end)];
}
