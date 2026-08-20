"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { termLabel, type TermKey } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Props = {
  readyTotal: [number, number];
  restarts: number;
  memory: string | null;
  accessURL: string | null;
};

export function MetricCards({ readyTotal, restarts, memory, accessURL }: Props) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const L = (key: TermKey) => termLabel(key, kube);
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      <Metric label={L("readyInstances")} value={`${readyTotal[0]} / ${readyTotal[1]}`} />
      <Metric label={L("restarts")} value={String(restarts)} />
      <Metric label={L("memory")} value={memory ?? "—"} />
      <Metric label={L("accessURL")} value={accessURL ?? "—"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1 text-xs text-muted-foreground">{label}</CardHeader>
      <CardContent className="pt-0 text-lg font-medium">{value}</CardContent>
    </Card>
  );
}
