"use client";

import { useTranslations } from "next-intl";
import { ERROR_DETAIL_LEVELS, errorDetailCookie, parseErrorDetailLevel } from "@/lib/error-detail";
import { useErrorDetail } from "./ErrorDetailProvider";

/**
 * Friendly / detailed / raw (#6), beside the theme and locale switches and built
 * the same way: a native <select>. The change applies at once through the
 * provider, and the cookie makes the next server render start from it.
 */
export function ErrorDetailSwitch() {
  const t = useTranslations("shell");
  const { level, setLevel } = useErrorDetail();

  return (
    <select
      aria-label={t("errorDetailSwitchLabel")}
      value={level}
      onChange={(e) => {
        const next = parseErrorDetailLevel(e.target.value);
        if (!next) return;
        document.cookie = errorDetailCookie(next, window.location.protocol === "https:");
        setLevel(next);
      }}
      className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
    >
      {ERROR_DETAIL_LEVELS.map((value) => (
        <option key={value} value={value}>
          {t(`errorDetail.${value}`)}
        </option>
      ))}
    </select>
  );
}
