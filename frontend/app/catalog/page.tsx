import { apiFetch } from "@/lib/api-server";
import { CatalogBrowser } from "@/components/CatalogBrowser";
import type { CatalogCardTemplate } from "@/components/CatalogCard";

type ApiTemplate = {
  name: string;
  display_name: string;
  description: string | null;
  tags: string[] | null;
  current_version: number | null;
  current_status: string | null;
  owning_team_name?: string | null;
};

export default async function CatalogPage() {
  const res = await apiFetch("/v1/templates");
  // A failed list must never surface the backend body to the user. Log it
  // and render the (empty) catalog — the browser shows its own empty state.
  if (!res.ok) {
    console.error(`[catalog] templates fetch failed: ${res.status} ${await res.text()}`);
    return <CatalogBrowser templates={[]} />;
  }
  const data = (await res.json()) as { templates: ApiTemplate[] };

  const templates: CatalogCardTemplate[] = data.templates
    .filter((t: ApiTemplate) => t.current_status === "published" && t.current_version != null)
    .map((t) => ({
      name: t.name,
      display_name: t.display_name,
      description: t.description,
      tags: t.tags ?? [],
      current_version: t.current_version!,
      owning_team_name: t.owning_team_name,
    }));

  return <CatalogBrowser templates={templates} />;
}
