import Link from "next/link";
import { getTranslations } from "next-intl/server";

// Global 404. Reached via `notFound()` from server components (e.g. a release
// the caller can't see) and for unknown routes. Deliberately says "or no
// permission" — the backend answers 404 for both cases so we never leak
// whether a resource exists.
export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold">{t("notFoundTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("notFoundBody")}</p>
      <Link
        href="/"
        className="mt-6 inline-block rounded bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        {t("backToReleases")}
      </Link>
    </div>
  );
}
