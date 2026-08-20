import { getTranslations } from "next-intl/server";
import { ReleaseTable } from "@/components/ReleaseTable";
import { apiFetch } from "@/lib/api-server";

export default async function ReleasesPage() {
  const t = await getTranslations("releases");
  const res = await apiFetch("/v1/releases");
  const d = res.ok ? await res.json() : { releases: [] };

  return (
    <div>
      <h1 className="text-xl font-bold mb-4">{t("myTitle")}</h1>
      <ReleaseTable rows={d.releases ?? []} />
    </div>
  );
}
