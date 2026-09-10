// k8s resource kinds in the words a template's user would use (#39). The
// deploy form's preview and permission panel used to print `ConfigMap` and
// `create · demo` to someone the rest of the page calls "사용자" — the same
// raw-term leak the release detail page already hides behind its
// "show raw k8s terms" toggle. The friendly names live in the `kinds.*`
// message catalog; the raw kind is what that toggle shows.

export const KNOWN_KINDS = [
  "Deployment",
  "Service",
  "Ingress",
  "ConfigMap",
  "Secret",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "PersistentVolumeClaim",
] as const;

export type KnownKind = (typeof KNOWN_KINDS)[number];

const KNOWN = new Set<string>(KNOWN_KINDS);

export function isKnownKind(kind: string): kind is KnownKind {
  return KNOWN.has(kind);
}

/**
 * The label for a kind. Raw terms on, or a kind with no friendly name (a CRD,
 * a typo), shows the kind itself — an unknown word is better than a missing
 * message error or a guess.
 */
export function kindLabel(
  kind: string,
  kube: boolean,
  t: (key: KnownKind) => string,
): string {
  if (kube || !isKnownKind(kind)) return kind;
  return t(kind);
}
