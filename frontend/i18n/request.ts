import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";
export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * Explicit, so a formatted timestamp means the same thing in the server render
 * and in the browser. Without it next-intl falls back to whichever zone the
 * process happens to run in, which differs between the OCI node and the
 * reader's laptop and shows up as a hydration mismatch.
 *
 * Fixed rather than per-user: kubeport has no timezone preference yet, and a
 * wrong-but-consistent zone is easier to reason about than a value that
 * changes with the deployment host. Revisit if non-KST users show up.
 */
export const TIME_ZONE = "Asia/Seoul";

function isLocale(v: string | undefined): v is Locale {
  return !!v && (LOCALES as readonly string[]).includes(v);
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: TIME_ZONE,
    // Pinned per request and handed to the client provider so the server render
    // and the hydrated render of relative times ("2시간 전") start from one
    // clock. Left unset, the server and the browser each use their own
    // `Date.now()` and disagree on hydration. RelativeTime advances from this
    // value with useNow, because the root layout — and so this value — does not
    // re-render on a client-side navigation (#100).
    now: new Date(),
  };
});
