"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { applyThemeClass, parseTheme, THEMES, themeCookie, type Theme } from "@/lib/theme";

/**
 * Light / dark / system (#155). Built like LocaleSwitch beside it: a native
 * <select>, so keyboard use and "current value" announcement come from the
 * platform rather than from ARIA we would have to get right.
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
    <select
      aria-label={t("themeSwitchLabel")}
      value={theme}
      onChange={(e) => pick(parseTheme(e.target.value))}
      className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
    >
      {THEMES.map((value) => (
        <option key={value} value={value}>
          {t(`theme.${value}`)}
        </option>
      ))}
    </select>
  );
}
