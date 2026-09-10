// Where the demo reset cadence comes from.
//
// The cadence lives in the chart (`demo.resetSchedule`) because that is what
// creates the CronJob. It used to live here too, as `everyHours = 6`, and the
// two drifted the moment the schedule changed: the banner told every logged-in
// visitor "next reset 15:00" while the CronJob was set to 21:00 (#153). A
// number that has to be kept in step by hand will not be.
//
// So the schedule is passed in (DEMO_RESET_SCHEDULE, same configmap that
// already carries DEMO_EMAIL_DOMAIN) and read here, and an unparseable one
// yields null rather than a guess — the banner then omits the time instead of
// naming a wrong one.

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Hours a cron hour-field fires on, or null if it is a form we do not read. */
function hoursOf(field: string): number[] | null {
  if (field === "*") return ALL_HOURS;

  const step = /^\*\/(\d{1,2})$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    if (n < 1 || n > 23) return null;
    return ALL_HOURS.filter((h) => h % n === 0);
  }

  const list: number[] = [];
  for (const part of field.split(",")) {
    if (!/^\d{1,2}$/.test(part)) return null;
    const h = Number(part);
    if (h > 23) return null;
    list.push(h);
  }
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : null;
}

/** The next UTC firing of `schedule` strictly after `now`.
 *
 * Reads the shapes `demo.resetSchedule` can hold — a fixed minute with an hour
 * field that is a wildcard, a step, or a comma list of hours — and returns null
 * for anything else,
 * including any use of the day-of-month, month or day-of-week fields. Returning
 * null is the point: the caller has to decide what to show when the time is
 * unknown, which is what stops a wrong time from reaching the screen.
 */
export function nextResetAt(now: Date, schedule: string | undefined | null): Date | null {
  if (!schedule) return null;
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  // A schedule that narrows by date or weekday is not a simple daily cadence,
  // and guessing at one would put us back where #153 started.
  if (f[2] !== "*" || f[3] !== "*" || f[4] !== "*") return null;
  if (!/^\d{1,2}$/.test(f[0])) return null;
  const minute = Number(f[0]);
  if (minute > 59) return null;
  const hours = hoursOf(f[1]);
  if (!hours) return null;

  for (const dayOffset of [0, 1]) {
    for (const h of hours) {
      const at = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + dayOffset,
        h,
        minute,
      ));
      // Strictly after: called at exactly a firing instant, the useful answer
      // is the *next* one, not the reset already happening.
      if (at.getTime() > now.getTime()) return at;
    }
  }
  return null;
}
