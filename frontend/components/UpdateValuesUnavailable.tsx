"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Shown in place of an update form whose release could not be read (#296).
 *
 * Deliberately no form at all. One started without the release's values fills
 * its Secret fields from ui-spec defaults, and submitting it would overwrite
 * the running Secret with them.
 *
 * Retry is `router.refresh()`: it re-runs the server page, which reads the
 * release again, without a full reload.
 */
export function UpdateValuesUnavailable({ releaseId }: { releaseId: string }) {
  const t = useTranslations("deploy.updateUnavailable");
  const router = useRouter();
  return (
    <div role="alert" className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button type="button" onClick={() => router.refresh()}>
          {t("retry")}
        </Button>
        <Link
          href={`/releases/${encodeURIComponent(releaseId)}`}
          className={buttonVariants({ variant: "outline" })}
        >
          {t("backToRelease")}
        </Link>
      </div>
    </div>
  );
}
