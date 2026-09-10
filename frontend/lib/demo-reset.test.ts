import { describe, expect, it } from "vitest";
import { nextResetAt } from "./demo-reset";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("nextResetAt", () => {
  // The cadence that shipped 2026-09-10: daily at 21:00 UTC = 06:00 KST.
  it("finds the next firing of a daily schedule", () => {
    expect(iso(nextResetAt(new Date("2026-09-10T01:20:00Z"), "0 21 * * *")))
      .toBe("2026-09-10T21:00:00.000Z");
    // Past today's firing, so the answer rolls to tomorrow.
    expect(iso(nextResetAt(new Date("2026-09-10T21:30:00Z"), "0 21 * * *")))
      .toBe("2026-09-11T21:00:00.000Z");
  });

  // Called at the firing instant, the useful answer is the next one — not the
  // reset already running.
  it("is strictly after now", () => {
    expect(iso(nextResetAt(new Date("2026-09-10T21:00:00Z"), "0 21 * * *")))
      .toBe("2026-09-11T21:00:00.000Z");
  });

  // The cadence this replaced. Kept because a chart could still hold it, and
  // because it is the case the old hardcoded helper covered.
  it("still handles a step schedule", () => {
    expect(iso(nextResetAt(new Date("2026-09-07T05:59:00Z"), "0 */6 * * *")))
      .toBe("2026-09-07T06:00:00.000Z");
    expect(iso(nextResetAt(new Date("2026-09-07T06:00:00Z"), "0 */6 * * *")))
      .toBe("2026-09-07T12:00:00.000Z");
    // Last firing of the day: crosses midnight.
    expect(iso(nextResetAt(new Date("2026-09-07T23:30:00Z"), "0 */6 * * *")))
      .toBe("2026-09-08T00:00:00.000Z");
  });

  it("honours the minute field and hour lists", () => {
    expect(iso(nextResetAt(new Date("2026-09-10T21:10:00Z"), "30 21 * * *")))
      .toBe("2026-09-10T21:30:00.000Z");
    expect(iso(nextResetAt(new Date("2026-09-10T07:00:00Z"), "0 3,9,15 * * *")))
      .toBe("2026-09-10T09:00:00.000Z");
  });

  // Returning null is the whole point of the rewrite: the banner omits the
  // time rather than naming a wrong one (#153). A schedule that narrows by
  // date or weekday is not a daily cadence, and guessing would reintroduce
  // exactly the bug this replaces.
  it.each([
    ["", "empty"],
    [undefined, "unset env var"],
    ["0 21 * * 1", "day-of-week narrowed"],
    ["0 21 1 * *", "day-of-month narrowed"],
    ["0 21 * 3 *", "month narrowed"],
    ["0 21 * *", "too few fields"],
    ["*/5 * * * *", "minute is not a fixed value"],
    ["0 24 * * *", "hour out of range"],
    ["60 21 * * *", "minute out of range"],
    ["0 */0 * * *", "zero step"],
    ["0 abc * * *", "not a number"],
  ] as [string | undefined, string][])("returns null: %s (%s)", (schedule) => {
    expect(nextResetAt(new Date("2026-09-10T01:20:00Z"), schedule)).toBeNull();
  });
});
