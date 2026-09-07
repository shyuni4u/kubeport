export function isDemoEmail(
  email: string | null | undefined,
  domain: string = process.env.DEMO_EMAIL_DOMAIN ?? "demo.kubeport",
): boolean {
  if (!email || !domain) return false;
  return email.toLowerCase().endsWith("@" + domain.toLowerCase());
}

/** Next UTC boundary of the reset CronJob (`0 *\/6 * * *`). */
export function nextResetAt(now: Date, everyHours = 6): Date {
  const ms = everyHours * 3600 * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms + ms);
}

/** Appends a 4-char lowercase suffix for demo users so two visitors deploying
 *  the same template with the default name don't collide on (cluster, ns, name). */
export function withDemoSuffix(name: string, isDemo: boolean, rand: () => number = Math.random): string {
  if (!isDemo) return name;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return `${name}-${s}`;
}
