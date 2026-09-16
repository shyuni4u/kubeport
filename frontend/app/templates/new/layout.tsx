import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { isDemoEmail } from "@/lib/demo";

export default async function NewTemplateLayout({ children }: { children: React.ReactNode }) {
  const me = await apiFetch("/v1/me").then((r) => r.ok ? r.json() : null).catch(() => null);
  const t = await getTranslations("templates.editor");
  return (
    <>
      {isDemoEmail(me?.email) && (
        <aside className="mb-6 rounded-lg border bg-card p-4 text-sm leading-relaxed">
          <p>{t("demoPractice")}</p>
          <Link href="/templates" className="mt-2 inline-flex min-h-10 items-center font-medium text-link underline underline-offset-4">
            {t("existingTemplates")}
          </Link>
        </aside>
      )}
      {children}
    </>
  );
}
