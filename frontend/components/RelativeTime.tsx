"use client";

import { useFormatter, useNow } from "next-intl";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = { iso: string; className?: string };

// How often the phrase is recomputed. Relative phrases change by the minute at
// the finest, and half that keeps a tab opened after a client-side navigation
// from showing a stale phrase for long.
export const RELATIVE_TIME_UPDATE_MS = 30_000;

/**
 * "2시간 전" with the exact timestamp one hover, focus or tap away (spec §6.2).
 *
 * `new Date(x).toLocaleString()` — what this replaces — follows the runtime's
 * locale and zone rather than the app's, so a Korean UI rendered
 * "9/9/2026, 12:00:05 AM" (#40). next-intl's formatter uses the locale, the
 * pinned TIME_ZONE, and the request's pinned `now`, so the server render and
 * the hydrated render agree.
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
  const absolute = format.dateTime(date, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
