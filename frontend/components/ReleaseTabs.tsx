"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const TABS = [
  { key: "overview", suffix: "" },
  { key: "logs", suffix: "/logs" },
] as const;

export function ReleaseTabs({ releaseId }: { releaseId: string }) {
  const pathname = usePathname();
  const t = useTranslations("releases.tabs");
  const base = `/releases/${releaseId}`;
  return (
    <nav className="flex gap-4 border-b">
      {TABS.map((tab) => {
        const href = base + tab.suffix;
        const active = pathname === href;
        return (
          <Link
            key={tab.key}
            href={href}
            className={`px-3 py-2 text-sm ${
              active
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
