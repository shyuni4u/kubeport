"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { SettingsSelect } from "./SettingsSelect";

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
    <SettingsSelect
      label={t("localeSwitchLabel")}
      value={current}
      disabled={pending}
      onValueChange={pick}
      options={OPTIONS}
    />
  );
}
