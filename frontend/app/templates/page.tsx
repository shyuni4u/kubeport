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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">{t("title")}</h1>
        <Link
          href="/templates/new"
          className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
        >
          {t("new")}
        </Link>
      </div>
      <table className="w-full bg-card border rounded">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="p-2 text-left">{t("colName")}</th>
            <th className="p-2 text-left">{t("colVersion")}</th>
            <th className="p-2 text-left">{t("colDescription")}</th>
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <tr className="border-t">
              <td colSpan={3} className="p-6 text-center text-sm text-muted-foreground">
                <p>{t("empty")}</p>
                <Link href="/templates/new" className="mt-2 inline-block text-link">
                  {t("emptyCta")}
                </Link>
              </td>
            </tr>
          )}
          {templates.map((tpl) => (
            <tr key={tpl.name} className="border-t">
              <td className="p-2">
                <Link
                  href={`/templates/${tpl.name}`}
                  className="text-link"
                >
                  {tpl.display_name}
                </Link>
              </td>
              <td className="p-2">v{tpl.current_version ?? "—"}</td>
              <td className="p-2 text-muted-foreground">{tpl.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
