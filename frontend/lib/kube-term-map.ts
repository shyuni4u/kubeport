const KUBE = {
  readyInstances: "Ready Pods",
  restarts: "Restart Count",
  memory: "Memory Usage",
  accessURL: "Service DNS",
  instances: "Pods",
  instanceId: "Pod Name",
  status: "Phase",
} as const;

const FRIENDLY: Record<keyof typeof KUBE, string> = {
  readyInstances: "준비된 인스턴스",
  restarts: "재시작",
  memory: "메모리",
  accessURL: "접근 URL",
  instances: "인스턴스",
  instanceId: "인스턴스 ID",
  status: "상태",
};

export type TermKey = keyof typeof KUBE;

export function termLabel(key: TermKey, kube: boolean): string {
  return kube ? KUBE[key] : FRIENDLY[key];
}
