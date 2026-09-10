import { parseAllDocuments, parse } from "yaml";

import { canonicalizePath, joinPath, splitHead } from "./template-path";

// Mirrors backend UIModeTemplate / UIResource / UIField exactly so the state
// we build here round-trips through POST /v1/templates/:name/versions.
export interface UISpecEntry {
  path: string;
  label: string;
  help?: string;
  type: string;
  min?: number;
  max?: number;
  pattern?: string;
  values?: string[];
  default?: unknown;
  required?: boolean;
}

export interface UIField {
  mode: "fixed" | "exposed";
  fixedValue?: unknown;
  uiSpec?: UISpecEntry;
}

export interface UIResource {
  apiVersion: string;
  kind: string;
  name: string;
  fields: Record<string, UIField>;
}

export interface UIModeState {
  resources: UIResource[];
}

export interface YamlToUIResult {
  uiState: UIModeState;
  warnings: string[];
}

// Walk a parsed YAML value and emit dotted/indexed paths for every scalar
// leaf. `apiVersion`, `kind`, `metadata.name` are skipped — they're stored on
// UIResource itself. Everything else becomes a `fixed` field so the round-trip
// through SerializeUIMode reproduces the original document byte-for-byte
// (modulo YAML formatting). UI-spec fields get their `fixed` entries later
// overwritten to `exposed`.
//
// Keys go through joinPath rather than string concatenation. A key holding
// `.`, `-` or `/` — `app.kubernetes.io/name`, an annotation, a ConfigMap
// filename — has to be quoted, or this generates a path the backend cannot
// read back and opening the template in UI mode is a 400 (issue #129).
function walkScalars(
  value: unknown,
  path: string,
  fields: Record<string, UIField>,
  warnings: string[],
): void {
  if (value === null || value === undefined) {
    // preserve nulls explicitly as fixed — SerializeUIMode can handle them.
    fields[path] = { mode: "fixed", fixedValue: value };
    return;
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    fields[path] = { mode: "fixed", fixedValue: value };
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      // Empty arrays round-trip as empty fields — serializer creates the key
      // only when a child path exists, so we skip rather than emit a fake
      // entry. Warn only if the user might expect to see it in the tree.
      return;
    }
    value.forEach((item, i) => walkScalars(item, `${path}[${i}]`, fields, warnings));
    return;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const child = joinPath(path, k);
      if (child === null) {
        // A key holding both quote styles has no spelling in this grammar.
        // Dropping it loudly beats emitting a path that parses as something
        // else — the admin can see which key the editor cannot represent.
        warnings.push(`key cannot be addressed by a path (it holds both quote styles): ${path ? `${path}.` : ""}${k}`);
        continue;
      }
      walkScalars(v, child, fields, warnings);
    }
    return;
  }
  warnings.push(`unsupported value type at ${path}: ${t}`);
}

// Convert a yaml-authored template's (resources, ui-spec) pair into the UI
// editor's state. Returns warnings for lossy or unusual inputs so the caller
// can surface them to the admin before they accept the conversion.
export function yamlToUIState(resourcesYaml: string, uiSpecYaml: string): YamlToUIResult {
  const warnings: string[] = [];
  const resources: UIResource[] = [];

  // 1. Parse each document in resources.yaml into its own UIResource.
  const docs = parseAllDocuments(resourcesYaml);
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      warnings.push(`YAML parse error: ${doc.errors[0].message}`);
      continue;
    }
    const value = doc.toJS() as Record<string, unknown> | null;
    if (!value || typeof value !== "object") continue;
    const apiVersion = typeof value.apiVersion === "string" ? value.apiVersion : "";
    const kind = typeof value.kind === "string" ? value.kind : "";
    const metadata = value.metadata as Record<string, unknown> | undefined;
    const name = metadata && typeof metadata.name === "string" ? metadata.name : "";
    if (!apiVersion || !kind || !name) {
      warnings.push(`resource skipped: missing apiVersion/kind/metadata.name (${JSON.stringify({ apiVersion, kind, name })})`);
      continue;
    }
    const fields: Record<string, UIField> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "apiVersion" || k === "kind") continue;
      if (k === "metadata") {
        // Guard: malformed YAML could have a scalar / array `metadata`. Plain
        // `Object.entries(nonObject)` either returns `[]` silently or walks
        // stringified characters, so we'd emit nonsense paths like
        // `metadata.0`. Require an actual object before iterating.
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          warnings.push(`resource ${kind}[${name}] metadata is not an object; skipped`);
          continue;
        }
        for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
          if (mk === "name") continue;
          const sub = joinPath("metadata", mk);
          if (sub === null) {
            warnings.push(`key cannot be addressed by a path (it holds both quote styles): metadata.${mk}`);
            continue;
          }
          walkScalars(mv, sub, fields, warnings);
        }
        continue;
      }
      walkScalars(v, k, fields, warnings);
    }
    resources.push({ apiVersion, kind, name, fields });
  }

  // 2. Apply ui-spec overrides — exposed fields get promoted from "fixed" to
  //    "exposed" with the full UISpecEntry attached. Unmatched paths become
  //    warnings rather than silent drops.
  try {
    const spec = parse(uiSpecYaml) as { fields?: UISpecEntry[] } | null;
    const entries = spec?.fields ?? [];
    for (const entry of entries) {
      // splitHead rather than a regex of its own. The copy that used to live
      // here required a selector, so `Deployment.spec.replicas` — a spelling
      // openapi.yaml documents as valid — fell through to the warning below.
      // That did not just warn: every scalar is already a `fixed` field by
      // this point, so skipping the promotion demoted an exposed field to
      // fixed, and it disappeared from the deploy form on the next save.
      const head = splitHead(entry.path);
      if (!head || head.rest === "") {
        warnings.push(`ui-spec path unparseable: ${entry.path}`);
        continue;
      }
      const { kind, selector } = head;
      const ofKind = resources.filter((r) => r.kind === kind);
      // An omitted selector means "the only document of this Kind", matching
      // the backend's findDoc. Ambiguity is reported rather than guessed.
      const res =
        selector === ""
          ? ofKind.length === 1
            ? ofKind[0]
            : undefined
          : ofKind.find((r) => r.name === selector || String(ofKind.indexOf(r)) === selector);
      if (!res) {
        warnings.push(
          selector === "" && ofKind.length > 1
            ? `ui-spec path omits a selector but ${ofKind.length} ${kind} documents exist: ${entry.path}`
            : `ui-spec entry references missing resource ${kind}[${selector}]`,
        );
        continue;
      }
      const sub = head.rest;
      // Strip the `Kind[name].` prefix before storing; UIField keys are the
      // resource-relative JSON path — canonicalized, because the parser accepts
      // spellings walkScalars never emits (`['a']`, `["replicas"]`). Indexing
      // by the raw text let an equivalent spelling create a SECOND entry beside
      // the generated `fixed` one; both then described the same YAML key and
      // SerializeUIMode wrote whichever Go's map iteration reached last.
      const key = canonicalizePath(sub);
      if (key === null) {
        warnings.push(`ui-spec path unparseable: ${entry.path}`);
        continue;
      }
      res.fields[key] = { mode: "exposed", uiSpec: entry };
    }
  } catch (e) {
    warnings.push(`ui-spec parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { uiState: { resources }, warnings };
}
