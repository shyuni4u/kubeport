import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MetricCards } from "@/components/MetricCards";
import { InstancesTable, type Instance } from "@/components/InstancesTable";

type ReleaseOverview = {
  id: string;
  instances_total: number;
  instances_ready: number;
  instances: Instance[];
};

export default async function ReleaseOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("releases.overview");
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) notFound();
  const d = (await res.json()) as ReleaseOverview;
  const restarts = d.instances.reduce((s, i) => s + i.restarts, 0);

  return (
    <div className="flex flex-col gap-6">
      <MetricCards
        readyTotal={[d.instances_ready, d.instances_total]}
        restarts={restarts}
        memory={null}
        accessURL={null}
      />
      <section>
        <h2 className="mb-2 text-sm font-medium">
          {t("instancesHeading", { count: d.instances.length })}
        </h2>
        <InstancesTable releaseId={d.id} instances={d.instances} />
      </section>
    </div>
  );
}
