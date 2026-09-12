/**
 * "UTC+9", "UTC+5:30", "UTC-4" or "UTC" — the offset of `timeZone` at `date`,
 * or null when there is no zone or the runtime does not know it.
 *
 * Worked out from numbers rather than asked of ICU as a zone *name*
 * (`timeZoneName: "short"`): the name depends on the ICU data each runtime
 * ships, so the server could render "GMT+9" and a browser "KST", and the text
 * would change at hydration. The offset is the same arithmetic everywhere (#142).
 */
export function utcOffsetLabel(date: Date, timeZone: string | undefined): string | null {
  if (!timeZone || Number.isNaN(date.getTime())) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    const wallClockAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const minutes = Math.round((wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
    if (!Number.isFinite(minutes)) return null;
    if (minutes === 0) return "UTC";
    const sign = minutes > 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  } catch {
    return null;
  }
}
