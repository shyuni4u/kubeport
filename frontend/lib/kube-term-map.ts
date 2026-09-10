// Raw k8s terms shown when the "show k8s terms" toggle is on. These are
// deliberately not translated — they are the upstream identifiers an admin
// wants to see verbatim. The friendly labels live in `releases.terms.*` of
// the message catalogs and are resolved through the translator the caller
// passes in (`useTranslations("releases.terms")`).
const KUBE = {
  readyInstances: "Ready Pods",
  restarts: "Restart Count",
  memory: "Memory Usage",
  // The friendly label is "외부 주소" — a public address, which in k8s terms
  // is an Ingress, not a Service's in-cluster DNS name (#250).
  accessURL: "Ingress URL",
  instances: "Pods",
  instanceId: "Pod Name",
  status: "Phase",
  namespace: "Namespace",
} as const;

export type TermKey = keyof typeof KUBE;

export type TermTranslator = (key: TermKey) => string;

export function termLabel(key: TermKey, kube: boolean, t: TermTranslator): string {
  return kube ? KUBE[key] : t(key);
}
