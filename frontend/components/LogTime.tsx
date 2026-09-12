"use client";

import { useFormatter } from "next-intl";

/**
 * A log line's clock time, in the app's locale and pinned time zone.
 *
 * `new Date(ms).toLocaleTimeString()` — what this replaces — follows the
 * browser's locale and zone, so an English UI on a Korean machine read
 * "오후 2:53:56", and a visitor abroad saw log times hours away from every
 * other time on the page (#270). The same fix #40 made for RelativeTime and the
 * demo banner.
 *
 * No zone name here, unlike the absolute times elsewhere (#142): it would
 * repeat on every line, and these share the zone those times already name.
 */
export function LogTime({ ms }: { ms: number }) {
  const format = useFormatter();
  return <>{format.dateTime(new Date(ms), { timeStyle: "medium" })}</>;
}
