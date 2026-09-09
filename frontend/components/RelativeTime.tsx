"use client";

import { useFormatter } from "next-intl";

type Props = { iso: string; className?: string };

/**
 * "2시간 전" with the exact timestamp on hover (spec §6.2).
 *
 * `new Date(x).toLocaleString()` — what this replaces — follows the runtime's
 * locale and zone rather than the app's, so a Korean UI rendered
 * "9/9/2026, 12:00:05 AM" (#40). next-intl's formatter uses the locale, the
 * pinned TIME_ZONE, and the request's pinned `now`, so the server render and
 * the hydrated render agree.
 */
export function RelativeTime({ iso, className }: Props) {
  const format = useFormatter();
  const date = new Date(iso);
  // A malformed timestamp from the backend should not take the page down.
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={iso}
      title={format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })}
      className={className}
    >
      {format.relativeTime(date)}
    </time>
  );
}
