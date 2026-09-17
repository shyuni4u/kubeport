import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";

type TemplateRow = {
  name: string;
  display_name?: string;
  description?: string;
  current_version?: number | null;
};

export default async function TemplatesPage() {
  const t = await getTranslations("templates.list");
  const res = await apiFetch("/v1/templates");
  // A 403/500 must not masquerade as "no templates" — surface it through the
  // route error boundary instead of rendering an empty list.
  if (!res.ok) {
    throw new Error(`GET /v1/templates failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { templates?: TemplateRow[] };
  const templates = data.templates ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <Link
          href="/templates/new"
          className={buttonVariants()}
        >
          {t("new")}
        </Link>
      </div>
      <div className="overflow-x-auto rounded-[12px] border bg-card"><table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-4 text-left">{t("colName")}</th>
            <th scope="col" className="px-4 py-4 text-left">{t("colVersion")}</th>
            <th scope="col" className="px-4 py-4 text-left">{t("colDescription")}</th>
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <tr className="border-t hover:bg-hover">
              <td colSpan={3} className="p-6 text-center text-sm text-muted-foreground">
                <p>{t("empty")}</p>
                <Link href="/templates/new" className="mt-2 inline-block text-link">
                  {t("emptyCta")}
                </Link>
              </td>
            </tr>
          )}
          {templates.map((tpl) => (
            <tr key={tpl.name} className="border-t hover:bg-hover">
              <td className="px-4 py-4">
                <Link
                  href={`/templates/${encodeURIComponent(tpl.name)}`}
                  className="font-medium text-link hover:underline"
                >
                  {tpl.display_name || tpl.name}
                </Link>
              </td>
              <td className="px-4 py-4">{tpl.current_version == null ? "—" : `v${tpl.current_version}`}</td>
              <td className="px-4 py-4 text-muted-foreground">{tpl.description}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
