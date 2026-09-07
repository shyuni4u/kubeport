"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const KEY = "kbp_demo_banner_dismissed";

export function DemoBanner({ resetAtIso }: { resetAtIso: string }) {
  const t = useTranslations("demo");
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  const time = new Date(resetAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div role="status" className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span className="flex-1">{t("banner", { time })}</span>
      <button
        type="button"
        className="rounded px-2 py-0.5 hover:bg-amber-100"
        onClick={() => {
          try { sessionStorage.setItem(KEY, "1"); } catch {}
          setHidden(true);
        }}
      >
        {t("dismiss")}
      </button>
    </div>
  );
}
