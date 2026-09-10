import { getTranslations } from "next-intl/server";
import { StatusChip, statusChipVariantFromRelease } from "@/components/StatusChip";
import { KubeTermsToggle } from "@/components/KubeTermsToggle";
import { DeleteReleaseButton } from "@/components/DeleteReleaseButton";
import { RelativeTime } from "@/components/RelativeTime";

export type ReleaseHeaderData = {
  id: string;
  name: string;
  status: string;
  template: { name: string; version: number };
  cluster: string;
  namespace: string;
  created_at?: string;
};

export async function ReleaseHeader({ data }: { data: ReleaseHeaderData }) {
  const t = await getTranslations("releases.status");
  const tm = await getTranslations("releases.meta");
  // The status string comes from the backend (`healthy` / `warning` / `error` /
  // `unknown` / `cluster-unreachable` / `resources-missing`). next-intl throws
  // for missing keys, so a backend that ships a new status before the frontend
  // can fall through to the raw key — useful in dev, harmless in prod.
  let label: string;
  try {
    label = t(data.status);
  } catch {
    label = data.status;
  }
  return (
    <header className="flex flex-col gap-2">
      {/* Wraps: the terms switch label grew and gained a (?) hint (#249), and
          with a long release name the row ran off a 390px screen. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 break-all font-mono text-xl font-medium">{data.name}</h1>
        <StatusChip variant={statusChipVariantFromRelease(data.status)}>
          {label}
        </StatusChip>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <KubeTermsToggle />
          {/* Stale releases (cluster gone / resources missing) can't be deleted the
              normal way; ReleaseStaleBanner offers the admin force-delete instead. */}
          {data.status !== "cluster-unreachable" && data.status !== "resources-missing" && (
            <DeleteReleaseButton releaseId={data.id} name={data.name} />
          )}
        </div>
      </div>
      <div className="text-sm text-muted-foreground">
        {data.template.name} v{data.template.version} · {data.cluster} / {data.namespace}
        {data.created_at ? (
          <>
            {" · "}
            {/*
              t.rich, not string concatenation: Korean puts "배포" after the
              time and English puts "deployed" before it, so the word order
              has to live in the message, not in the JSX (#40).
            */}
            {tm.rich("deployedAt", {
              time: () => <RelativeTime iso={data.created_at!} />,
            })}
          </>
        ) : null}
      </div>
    </header>
  );
}
