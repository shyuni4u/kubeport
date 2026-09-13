import YAML from "yaml";

/**
 * What the deploy form accepts as a release name (#182).
 *
 * The API is looser: it takes any RFC 1123 hostname that is also a Kubernetes
 * label value, uppercase and dots included (backend/internal/api/releases.go
 * binding, release_ownership.go). The form holds to what its own help text has
 * always promised — a DNS-1123 label: lowercase letters, digits and hyphens,
 * starting and ending with a letter or digit. Stricter than the server costs a
 * visitor nothing they would miss, and keeps one rule on screen instead of a
 * sentence that says one thing and a check that allows another.
 */
export const RELEASE_NAME_MAX_LENGTH = 63;

const RELEASE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * What a template version leaves a release name (#190). A single-instance
 * template names its objects itself, so the name is only the release's. A
 * multi-instance one names every object `<release>-<name>`, and those names
 * have limits of their own: the backend refuses a release name that breaks one
 * with a 400 (backend/internal/template/instances.go nameProblems), and the
 * form says the same before anyone submits.
 */
export type ReleaseNameRules = {
  multiple: boolean;
  /** The longest release name every object's new name still fits. */
  maxLength: number;
  /** A Service's name is a DNS-1035 label, which starts with a letter. */
  letterFirst: boolean;
};

export const SINGLE_INSTANCE_RULES: ReleaseNameRules = {
  multiple: false,
  maxLength: RELEASE_NAME_MAX_LENGTH,
  letterFirst: false,
};

// instances.go nameLimit: the CronJob controller appends 11 characters to name
// each Job, which must still fit a label.
function objectNameLimit(kind: string): number {
  return kind === "CronJob" ? 52 : RELEASE_NAME_MAX_LENGTH;
}

export function releaseNameRules(uiSpecYaml: string, resourcesYaml: string): ReleaseNameRules {
  let instances: unknown;
  try {
    instances = (YAML.parse(uiSpecYaml) as { instances?: unknown } | null)?.instances;
  } catch {
    return SINGLE_INSTANCE_RULES;
  }
  if (instances !== "multiple") return SINGLE_INSTANCE_RULES;

  let maxLength = RELEASE_NAME_MAX_LENGTH;
  let letterFirst = false;
  // A document that does not parse is the backend's to refuse; the form keeps
  // what the ones that do parse say.
  for (const doc of YAML.parseAllDocuments(resourcesYaml)) {
    if (doc.errors.length > 0) continue;
    const obj = doc.toJS() as { kind?: unknown; metadata?: { name?: unknown } } | null;
    const kind = obj?.kind;
    const name = obj?.metadata?.name;
    if (typeof kind !== "string" || typeof name !== "string" || name === "") continue;
    maxLength = Math.min(maxLength, objectNameLimit(kind) - 1 - name.length);
    if (kind === "Service") letterFirst = true;
  }
  return { multiple: true, maxLength: Math.max(1, maxLength), letterFirst };
}

export type ReleaseNameProblem = "empty" | "tooLong" | "format" | "letterFirst";

export function releaseNameProblem(
  name: string,
  rules: ReleaseNameRules = SINGLE_INSTANCE_RULES,
): ReleaseNameProblem | null {
  if (name.trim() === "") return "empty";
  // Checked before the format so a long but otherwise valid name gets the
  // advice that actually fixes it. The input's maxLength stops typing past
  // it, but not a prefilled value.
  if (name.length > rules.maxLength) return "tooLong";
  if (!RELEASE_NAME_RE.test(name)) return "format";
  if (rules.letterFirst && !/^[a-z]/.test(name)) return "letterFirst";
  return null;
}
