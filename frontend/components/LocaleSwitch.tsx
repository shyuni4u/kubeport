"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

type Locale = "ko" | "en";
const OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
];
const ONE_YEAR = 60 * 60 * 24 * 365;

export function LocaleSwitch() {
  const current = useLocale() as Locale;
  const router = useRouter();
  const t = useTranslations("shell");
  const [pending, startTransition] = useTransition();

  function pick(next: Locale) {
    document.cookie = `NEXT_LOCALE=${next}; Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax`;
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <select
      aria-label={t("localeSwitchLabel")}
      value={current}
      disabled={pending}
      onChange={(e) => pick(e.target.value as Locale)}
      className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-60"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
