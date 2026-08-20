import { getTranslations } from "next-intl/server";
import { StatusChip, statusChipVariantFromRelease } from "@/components/StatusChip";
import { KubeTermsToggle } from "@/components/KubeTermsToggle";

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
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-xl font-medium">{data.name}</h1>
        <StatusChip variant={statusChipVariantFromRelease(data.status)}>
          {label}
        </StatusChip>
        <div className="ml-auto">
          <KubeTermsToggle />
        </div>
      </div>
      <div className="text-sm text-muted-foreground">
        {data.template.name} v{data.template.version} · {data.cluster} / {data.namespace}
        {data.created_at ? ` · ${new Date(data.created_at).toLocaleString()}` : ""}
      </div>
    </header>
  );
}
