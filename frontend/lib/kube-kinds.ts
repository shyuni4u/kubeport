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

// The API group each friendly name belongs to. A kind name alone is not an
// identity: Knative's `serving.knative.dev/v1` Service is not a core Service,
// and calling it "내부 주소" would describe something it is not.
const GROUP_OF: Record<KnownKind, string> = {
  Deployment: "apps",
  Service: "",
  Ingress: "networking.k8s.io",
  ConfigMap: "",
  Secret: "",
  StatefulSet: "apps",
  DaemonSet: "apps",
  Job: "batch",
  CronJob: "batch",
  PersistentVolumeClaim: "",
};

export function isKnownKind(kind: string): kind is KnownKind {
  return Object.prototype.hasOwnProperty.call(GROUP_OF, kind);
}

/** The group part of an apiVersion: "apps/v1" → "apps", "v1" → "". */
export function groupOf(apiVersion: string): string {
  const slash = apiVersion.lastIndexOf("/");
  return slash < 0 ? "" : apiVersion.slice(0, slash);
}

/**
 * The label for a kind. Raw terms on, a kind with no friendly name, or a kind
 * whose apiVersion puts it in another group (a CRD reusing a core name) shows
 * the kind itself — an unknown word is better than a missing message error or
 * a wrong description. `apiVersion` is optional for callers that only know the
 * kind; they get the friendly name for any known kind.
 */
export function kindLabel(
  kind: string,
  kube: boolean,
  t: (key: KnownKind) => string,
  apiVersion?: string,
): string {
  if (kube || !isKnownKind(kind)) return kind;
  if (apiVersion !== undefined && groupOf(apiVersion) !== GROUP_OF[kind]) return kind;
  return t(kind);
}
