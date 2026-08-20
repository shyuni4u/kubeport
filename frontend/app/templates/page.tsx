import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";

export default async function TemplatesPage() {
  const t = await getTranslations("templates.list");
  const res = await apiFetch("/v1/templates");
  const data = res.ok ? await res.json() : { templates: [] };

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
      <table className="w-full bg-white border rounded">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="p-2 text-left">{t("colName")}</th>
            <th className="p-2 text-left">{t("colVersion")}</th>
            <th className="p-2 text-left">{t("colDescription")}</th>
          </tr>
        </thead>
        <tbody>
          {data.templates?.map((t: Record<string, string | number>) => (
            <tr key={t.name} className="border-t">
              <td className="p-2">
                <Link
                  href={`/templates/${t.name}`}
                  className="text-primary"
                >
                  {t.display_name}
                </Link>
              </td>
              <td className="p-2">v{t.current_version ?? "—"}</td>
              <td className="p-2 text-muted-foreground">{t.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
