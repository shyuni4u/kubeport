/**
 * Why a login attempt didn't finish, in terms the landing page can explain.
 *
 * The callback route puts one of these in `?login_error=` instead of throwing:
 * a raw 500 leaves the user on a blank error page with no way back, and
 * `app/error.tsx` doesn't catch route-handler exceptions anyway.
 */
export type LoginErrorCode = "cancelled" | "expired" | "failed";

const CODES: readonly LoginErrorCode[] = ["cancelled", "expired", "failed"];

/**
 * OAuth2/OIDC `error` values that mean "the user didn't go through with it"
 * rather than "something is broken". Everything else — including codes we've
 * never seen — is reported as a failure, since we can't promise a retry helps.
 */
const CANCELLED = new Set([
  "access_denied",
  "consent_required",
  "interaction_required",
  "login_required",
]);

export function loginErrorFromIdp(error: string): LoginErrorCode {
  return CANCELLED.has(error) ? "cancelled" : "failed";
}

/**
 * Narrow an untrusted `?login_error=` value to a known code. Anything else is
 * dropped so a crafted URL can't steer what the page renders.
 */
export function parseLoginError(value: string | null | undefined): LoginErrorCode | null {
  if (!value) return null;
  return (CODES as readonly string[]).includes(value) ? (value as LoginErrorCode) : null;
}
