import { apiFetch } from "@/lib/api-server";
import { ReleaseAutoRefresh } from "@/components/ReleaseAutoRefresh";
import { ReleaseHeader, type ReleaseHeaderData } from "@/components/ReleaseHeader";
import { ReleaseTabs } from "@/components/ReleaseTabs";
import { ReleaseStaleBanner, isStaleStatus } from "@/components/ReleaseStaleBanner";
import { releaseReadFailed } from "@/lib/release-read";
import { roleFromGroups } from "@/lib/role";

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
  if (!relRes.ok) releaseReadFailed(relRes.status, id);
  const data = (await relRes.json()) as ReleaseHeaderData;
  const me = meRes.ok
    ? ((await meRes.json()) as { groups?: string[] })
    : { groups: [] };
  const isAdmin = roleFromGroups(me.groups) === "admin";

  // Admins start with raw k8s terms and users with plain words (#39); that
  // starting value comes from KubeTermsProvider in the root shell (#247).
  return (
    <div className="flex flex-col gap-4">
      {/* Keeps the header, banner and overview current while the rollout is
          still settling, instead of until the reader reloads (#183). */}
      <ReleaseAutoRefresh status={data.status} />
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
