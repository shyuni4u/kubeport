"use client";

import { useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";

const KEY = "kbp_demo_banner_dismissed";

// sessionStorage is an external store: it doesn't exist during SSR, and reading
// it into state from an effect meant an extra render on every mount. Reading it
// through useSyncExternalStore keeps the server render (banner hidden, so it
// never flashes and disappears) and lets the dismiss button notify subscribers
// directly.
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function isDismissed() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    // Private mode or storage disabled — show the banner rather than hide it.
    return false;
  }
}

function dismiss() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // Can't persist; the banner still hides for this render pass below.
  }
  for (const onChange of listeners) onChange();
}

export function DemoBanner({ resetAtIso }: { resetAtIso: string }) {
  const t = useTranslations("demo");
  const format = useFormatter();
  // Server snapshot is "dismissed" so the markup matches the pre-hydration DOM.
  const hidden = useSyncExternalStore(subscribe, isDismissed, () => true);
  if (hidden) return null;
  // Formatted through next-intl, not `toLocaleTimeString([])`: the latter
  // follows the *browser's* locale, so an English UI showed "오후 03:00" (#40).
  const time = format.dateTime(new Date(resetAtIso), {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div role="status" className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span className="flex-1">{t("banner", { time })}</span>
      <button
        type="button"
        className="rounded px-2 py-0.5 hover:bg-amber-100"
        onClick={dismiss}
      >
        {t("dismiss")}
      </button>
    </div>
  );
}
