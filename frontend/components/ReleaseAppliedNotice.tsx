"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";

/**
 * The query the update form adds when it sends the reader back to the release
 * (#362). Exported so the form and this notice cannot disagree on the name.
 */
export const APPLIED_PARAM = "applied";

/**
 * Says an update went through, once, on the release the update form returned
 * to (#362).
 *
 * The form used to `router.push('/releases/<id>')` and nothing more, so the
 * screen the reader arrived on looked exactly like the one they had left — and
 * a same-version update often lands while the status still reads "healthy",
 * so not even the chip moved. Nothing said the change was applied, and the
 * natural reaction was to submit the same form again.
 *
 * The notice is non-blocking and says the status may change for a moment while
 * pods restart with the new settings, since that is what the reader sees next.
 *
 * It shows once: the query is taken off the URL straight away, so reloading,
 * sharing or going back to this address does not announce the update again.
 * Whether to show it is decided from the URL the component mounted with — the
 * update form is another route, so this layout mounts fresh on arrival and
 * the notice outlives the query it came from.
 */
export function ReleaseAppliedNotice() {
  const t = useTranslations("releases.applied");
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const arrived = searchParams.get(APPLIED_PARAM) === "1";
  // Fixed at mount: the query is about to be taken off the URL, and nothing
  // here should change when it is.
  const [arrivedAtMount] = useState(arrived);
  const [shown, setShown] = useState(arrived);
  // What the live region says. It starts empty and is filled after mount: a
  // status region inserted together with its text is often not announced —
  // screen readers speak changes to a region they already know about — and
  // arrival mounts this layout fresh, so the region and the sentence would
  // always appear in the same render.
  const [announcement, setAnnouncement] = useState("");
  // A string, so the effect below depends on the words and not on the
  // translator function's identity.
  const message = `${t("title")} ${t("body")}`;

  // Keyed on the mount-time value only, so taking the query off the URL (or a
  // refresh re-rendering this) cannot cancel the announcement before it lands.
  useEffect(() => {
    if (!arrivedAtMount) return;
    const fill = setTimeout(() => setAnnouncement(message), 0);
    return () => clearTimeout(fill);
  }, [arrivedAtMount, message]);

  useEffect(() => {
    if (!arrived) return;
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(APPLIED_PARAM);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [arrived, searchParams, pathname, router]);

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {shown && (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50 p-4 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="flex-1 space-y-1">
            <p className="font-medium">{t("title")}</p>
            <p className="text-sm text-muted-foreground">{t("body")}</p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
            onClick={() => setShown(false)}
          >
            {t("dismiss")}
          </button>
        </div>
      )}
    </>
  );
}
