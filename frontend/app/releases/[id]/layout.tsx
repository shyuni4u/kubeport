import { apiFetch } from "@/lib/api-server";
import { ReleaseHeader, type ReleaseHeaderData } from "@/components/ReleaseHeader";
import { ReleaseTabs } from "@/components/ReleaseTabs";
import { ReleaseStaleBanner, type StaleStatus } from "@/components/ReleaseStaleBanner";
import { roleFromGroups } from "@/lib/role";
import { notFound } from "next/navigation";

const STALE_STATUSES = new Set<StaleStatus>([
  "cluster-unreachable",
  "resources-missing",
]);

function isStaleStatus(status: string): status is StaleStatus {
  return STALE_STATUSES.has(status as StaleStatus);
}

export default async function ReleaseDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Fetch release + caller identity in parallel — the stale banner needs both
  // to decide between admin (force-delete button) and non-admin (contact-admin
  // hint) variants.
  const [relRes, meRes] = await Promise.all([
    apiFetch(`/v1/releases/${id}`),
    apiFetch("/v1/me"),
  ]);
  if (!relRes.ok) notFound();
  const data = (await relRes.json()) as ReleaseHeaderData;
  const me = meRes.ok
    ? ((await meRes.json()) as { groups?: string[] })
    : { groups: [] };
  const isAdmin = roleFromGroups(me.groups) === "admin";

  return (
    <div className="flex flex-col gap-4">
      <ReleaseHeader data={data} />
      {isStaleStatus(data.status) && (
        <ReleaseStaleBanner
          status={data.status}
          releaseId={id}
          cluster={data.cluster}
          isAdmin={isAdmin}
        />
      )}
      <ReleaseTabs releaseId={id} />
      {children}
    </div>
  );
}
