"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { applyThemeClass, parseTheme, THEMES, themeCookie, type Theme } from "@/lib/theme";
import { SettingsSelect } from "./SettingsSelect";

/**
 * Light / dark / system (#155), using the shared accessible settings menu.
 *
 * Unlike the locale there is nothing to re-render on the server: the change is
 * a class on <html>, applied here at once, and the cookie makes the next server
 * render agree with it. `initial` is the value the layout read from that same
 * cookie, so the server and hydrated renders of this control match.
 */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const t = useTranslations("shell");
  const [theme, setTheme] = useState<Theme>(initial);

  function pick(next: Theme) {
    document.cookie = themeCookie(next, window.location.protocol === "https:");
    applyThemeClass(document.documentElement, next);
    setTheme(next);
  }

  return (
    <SettingsSelect
      label={t("themeSwitchLabel")}
      value={theme}
      onValueChange={(value) => pick(parseTheme(value))}
      options={THEMES.map((value) => ({ value, label: t(`theme.${value}`) }))}
    />
  );
}
