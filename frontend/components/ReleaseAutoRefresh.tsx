"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Statuses that change on their own while the reader watches: `unknown` is a
// release with no pods yet (just deployed, image still pulling), `warning` one
// whose pods are not all ready. `healthy` and `error` are where a rollout
// lands, and the stale statuses need a person — none of those will look any
// different in three seconds.
const SETTLING = new Set(["unknown", "warning"]);

// Backoff between re-reads. The first ones are quick because a normal rollout
// settles within tens of seconds; after that there is no reason to hit the
// cluster every few seconds for a release that is taking its time.
export const REFRESH_DELAYS_MS = [3_000, 5_000, 8_000, 13_000, 15_000];

// A release can sit in `unknown` for good — a CronJob between runs has no pods
// — so polling stops eventually. Reloading the page starts it again.
export const REFRESH_GIVE_UP_MS = 5 * 60 * 1000;

/**
 * Re-reads the release detail while its status is still settling (#183).
 *
 * The page is server-rendered once, so a release deployed a moment ago stayed
 * "대기 중 · 0/1" until the reader reloaded, while the API had been answering
 * `healthy` for a minute. `router.refresh()` re-runs the server components —
 * header, stale banner, overview — without a full reload, the way ClusterPicker
 * already does, so client state such as an open log stream survives it.
 *
 * Renders nothing. The effect is keyed on `status`: once a refresh brings a
 * settled status, the effect is torn down and polling stops.
 */
export function ReleaseAutoRefresh({ status }: { status: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!SETTLING.has(status)) return;
    const started = Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (Date.now() - started >= REFRESH_GIVE_UP_MS) return;
      const delay = REFRESH_DELAYS_MS[Math.min(attempt, REFRESH_DELAYS_MS.length - 1)];
      timer = setTimeout(() => {
        attempt += 1;
        // A hidden tab has no reader; skip the round trip, keep the schedule.
        if (document.visibilityState !== "hidden") router.refresh();
        schedule();
      }, delay);
    };
    schedule();

    return () => clearTimeout(timer);
  }, [status, router]);

  return null;
}
