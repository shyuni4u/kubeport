"use client";

import { useSyncExternalStore } from "react";
import { useFormatter, useTimeZone, useTranslations } from "next-intl";
import { utcOffsetLabel } from "@/lib/utc-offset";

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

export function DemoBanner({ resetAtIso }: { resetAtIso: string | null }) {
  const t = useTranslations("demo");
  const format = useFormatter();
  const timeZone = useTimeZone();
  // Server snapshot is "dismissed" so the markup matches the pre-hydration DOM.
  const hidden = useSyncExternalStore(subscribe, isDismissed, () => true);
  if (hidden) return null;
  // Formatted through next-intl, not `toLocaleTimeString([])`: the latter
  // follows the *browser's* locale, so an English UI showed "오후 03:00" (#40).
  //
  // resetAtIso is null when the configured schedule is not a shape we read.
  // The banner still warns that a reset is coming; it just does not claim to
  // know when, because a wrong hour is worse than no hour (#153).
  //
  // The zone is labelled the way RelativeTime labels it (#142): the hour is
  // Asia/Seoul's, and a visitor elsewhere would otherwise plan around "06:00"
  // on their own clock.
  const resetAt = resetAtIso ? new Date(resetAtIso) : null;
  const time = resetAt
    ? [format.dateTime(resetAt, { hour: "2-digit", minute: "2-digit" }), utcOffsetLabel(resetAt, timeZone)]
        .filter(Boolean)
        .join(" ")
    : null;
  return (
    <div role="status" className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
      <span className="flex-1">{time ? t("banner", { time }) : t("bannerNoTime")}</span>
      <button
        type="button"
        className="rounded px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-500/20"
        onClick={dismiss}
      >
        {t("dismiss")}
      </button>
    </div>
  );
}
