"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { termLabel, type TermKey } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Props = {
  readyTotal: [number, number];
  restarts: number;
  // `null` = not available for this release; the card is hidden rather than
  // rendered as "—" (a dash reads as "broken" to a non-k8s user).
  memory: string | null;
  accessURL: string | null;
  releaseId?: string;
};

export function MetricCards({ readyTotal, restarts, memory, accessURL, releaseId }: Props) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const tTerms = useTranslations("releases.terms");
  const tOverview = useTranslations("releases.overview");
  const L = (key: TermKey) => termLabel(key, kube, tTerms);
  return (
    <div className="flex flex-col gap-2">
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <Metric label={L("readyInstances")} value={`${readyTotal[0]} / ${readyTotal[1]}`} />
        <Metric label={L("restarts")} value={String(restarts)} />
        {memory !== null && <Metric label={L("memory")} value={memory} />}
        {accessURL !== null && <Metric label={L("accessURL")} value={accessURL} />}
      </div>
      {accessURL === null && (
        <section className="mt-2 rounded-lg border bg-card p-4 space-y-2">
          <h2 className="font-semibold">{tOverview("nextTitle")}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{tOverview("noAccessUrlHint")}</p>
          {releaseId && <a className="inline-flex min-h-11 items-center text-sm font-medium text-link underline underline-offset-4" href={`/releases/${encodeURIComponent(releaseId)}/logs`}>{tOverview("openLogs")}</a>}
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1 text-sm text-muted-foreground">{label}</CardHeader>
      <CardContent className="pt-0 text-2xl font-medium">{value}</CardContent>
    </Card>
  );
}
