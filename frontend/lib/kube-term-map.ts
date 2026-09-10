// Raw k8s terms shown when the "show k8s terms" toggle is on. These are
// deliberately not translated — they are the upstream identifiers an admin
// wants to see verbatim. The friendly labels live in `releases.terms.*` of
// the message catalogs and are resolved through the translator the caller
// passes in (`useTranslations("releases.terms")`).
const KUBE = {
  readyInstances: "Ready Pods",
  restarts: "Restart Count",
  memory: "Memory Usage",
  // "외부 주소" can be an Ingress host or a LoadBalancer Service's external IP,
  // and nothing fills this card yet, so the raw name does not pick one (#250).
  // Not "Service DNS": a ClusterIP's svc.cluster.local name is not external.
  accessURL: "External Address",
  instances: "Pods",
  instanceId: "Pod Name",
  // What `kubectl get pods` calls the column. The cell shows a container's
  // waiting reason (CrashLoopBackOff…) when there is one, which is not
  // `.status.phase` — a "Phase" header pointed at the wrong field.
  status: "Status",
  namespace: "Namespace",
} as const;

export type TermKey = keyof typeof KUBE;

export type TermTranslator = (key: TermKey) => string;

export function termLabel(key: TermKey, kube: boolean, t: TermTranslator): string {
  return kube ? KUBE[key] : t(key);
}
