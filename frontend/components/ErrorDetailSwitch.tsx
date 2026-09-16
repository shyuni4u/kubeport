"use client";

import { useTranslations } from "next-intl";
import { ERROR_DETAIL_LEVELS, errorDetailCookie, parseErrorDetailLevel } from "@/lib/error-detail";
import { useErrorDetail } from "./ErrorDetailProvider";
import { SettingsSelect } from "./SettingsSelect";

/**
 * Friendly / detailed / raw (#6), sharing the theme and locale menu. The change applies at once through the
 * provider, and the cookie makes the next server render start from it.
 */
export function ErrorDetailSwitch() {
  const t = useTranslations("shell");
  const { level, setLevel } = useErrorDetail();

  return (
    <SettingsSelect
      label={t("errorDetailSwitchLabel")}
      value={level}
      onValueChange={(value) => {
        const next = parseErrorDetailLevel(value);
        if (!next) return;
        document.cookie = errorDetailCookie(next, window.location.protocol === "https:");
        setLevel(next);
      }}
      options={ERROR_DETAIL_LEVELS.map((value) => ({ value, label: t(`errorDetail.${value}`) }))}
    />
  );
}
