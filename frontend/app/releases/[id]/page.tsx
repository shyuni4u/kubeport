import { apiFetch } from "@/lib/api-server";
import { releaseReadFailed } from "@/lib/release-read";
import { MetricCards } from "@/components/MetricCards";
import { InstancesHeading } from "@/components/InstancesHeading";
import { InstancesTable, type Instance } from "@/components/InstancesTable";
import { isStaleStatus } from "@/components/ReleaseStaleBanner";
import { ReleaseProblems } from "@/components/ReleaseProblems";

type ReleaseOverview = {
  id: string;
  status: string;
  template: { name: string; version: number };
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
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) releaseReadFailed(res.status, id);
  const d = (await res.json()) as ReleaseOverview;
  const restarts = d.instances.reduce((s, i) => s + i.restarts, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* First, because it is the answer to the question a failing release
          raises: what went wrong, and what to do about it (#33). Renders
          nothing while every instance is fine. */}
      <ReleaseProblems
        releaseId={d.id}
        template={d.template.name}
        version={d.template.version}
        instances={d.instances}
        // Same severity as the header chip: a red "오류" above an amber panel
        // about the same failure made the reader guess which to believe (#114).
        tone={d.status === "error" ? "danger" : "warning"}
      />
      {/* The backend does not report memory usage or a public address yet.
          `null` hides those cards and shows the "no public address" hint
          instead of an empty "—" that reads as broken. */}
      <MetricCards
        readyTotal={[d.instances_ready, d.instances_total]}
        restarts={restarts}
        memory={null}
        accessURL={null}
      />
      <section>
        <InstancesHeading count={d.instances.length} />
        <InstancesTable
          releaseId={d.id}
          instances={d.instances}
          staleNotice={isStaleStatus(d.status)}
        />
      </section>
    </div>
  );
}
