"use client";

import { useFormatter, useLocale, useNow, useTimeZone } from "next-intl";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = { iso: string; className?: string };

// How often the phrase is recomputed. Relative phrases change by the minute at
// the finest, and half that keeps a tab opened after a client-side navigation
// from showing a stale phrase for long.
export const RELATIVE_TIME_UPDATE_MS = 30_000;

/**
 * The short name of `timeZone` at `date` in `locale` ("GMT+9", "KST"), or
 * null when the runtime cannot name it.
 *
 * Read separately rather than passed as `timeZoneName` to the formatter
 * below: Intl rejects `timeZoneName` combined with `dateStyle`/`timeStyle`,
 * and next-intl answers that by printing `Date.toString()` instead
 * ("Wed Sep 09 2026 19:00:00 GMT+0900 …").
 */
function zoneName(date: Date, locale: string, timeZone: string | undefined): string | null {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * "2시간 전" with the exact timestamp one hover, focus or tap away (spec §6.2).
 *
 * `new Date(x).toLocaleString()` — what this replaces — follows the runtime's
 * locale and zone rather than the app's, so a Korean UI rendered
 * "9/9/2026, 12:00:05 AM" (#40). next-intl's formatter uses the locale, the
 * pinned TIME_ZONE, and a clock that starts at the request's pinned `now` — so
 * the server render and the hydrated render agree — then advances every
 * RELATIVE_TIME_UPDATE_MS (#100).
 *
 * The absolute time used to live in `title` alone, with nothing to suggest it
 * was there: no underline, no cursor change, and — because `title` opens on
 * hover only — no way at all to reach it by touch or keyboard (#115). It is
 * now reachable three ways, which is why there is no `title` left to add a
 * fourth, duplicate, native popup on hover:
 *
 *   - sighted mouse/keyboard: the tooltip, on hover or focus
 *   - touch: the trigger is a real <button>, so a tap opens it — the same
 *     reason HelpHint renders one
 *   - screen readers: a visually hidden copy, read with the phrase itself so
 *     it needs no interaction to find
 */
export function RelativeTime({ iso, className }: Props) {
  const format = useFormatter();
  const locale = useLocale();
  const timeZone = useTimeZone();
  // The provider's `now` is pinned per request so the server render and the
  // hydrated render agree — but the root layout does not re-render on a
  // client-side navigation, so that `now` froze at the last full page load.
  // Seven minutes on the deploy form, then router.push to the new release:
  // "7분 후 배포", and a phrase that never moved while the tab stayed open
  // (#100). useNow starts from the same pinned value, so hydration still
  // matches, and then keeps the clock running.
  const now = useNow({ updateInterval: RELATIVE_TIME_UPDATE_MS });
  const date = new Date(iso);
  // A malformed timestamp from the backend should not take the page down.
  if (Number.isNaN(date.getTime())) return null;
  // Until the first tick the clock can still be behind, and the app and the
  // database clocks can disagree by seconds — either would show something that
  // just happened as "in a few seconds". Nothing here is scheduled for the
  // future, so a future timestamp reads as now.
  const shown = date.getTime() > now.getTime() ? now : date;
  // The zone is named: every time is pinned to TIME_ZONE (Asia/Seoul), and an
  // English reader in London took "Sep 9, 2026, 4:36 PM" for their own clock —
  // eight hours off, with nothing on screen to say so (#142). The zone stays
  // pinned; only the label is new.
  const zone = zoneName(date, locale, timeZone);
  const absolute = [
    format.dateTime(date, { dateStyle: "medium", timeStyle: "short" }),
    zone,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              // Dotted underline is the affordance itself: it is what says
              // "there is more here" before anyone hovers. Kept subtle — this
              // sits inside a sentence, not on its own.
              "cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2",
              "focus-visible:outline-2 focus-visible:outline-ring",
              className,
            )}
          />
        }
      >
        <time dateTime={iso}>{format.relativeTime(shown, now)}</time>
        <span className="sr-only"> ({absolute})</span>
      </TooltipTrigger>
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}
