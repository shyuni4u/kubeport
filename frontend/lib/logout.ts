/**
 * POSTs the logout and reports whether it actually happened.
 *
 * Shared by the logout confirmation screen and the top-bar menu, because both
 * have to read the answer the same way (#166):
 *
 * - `redirect: "manual"` so the response is the logout route's own. The route
 *   replies 303 to "/", and the default "follow" would fetch the landing page
 *   and report ITS status — "did the logout work?" would depend on whether
 *   landing rendered, and `Response.ok` is false for a 303 anyway.
 * - Under "manual" a browser turns that 303 into an opaque redirect (type
 *   "opaqueredirect", status 0). That, a plain 3xx, or a 2xx is success.
 * - Anything else — a 403 from the route's Origin check, which is what every
 *   logout gets once the domain changes without PUBLIC_ORIGIN following, or a
 *   request that never landed — is failure, and the caller must not navigate
 *   as if the session were gone.
 *
 * The POST carries the same-origin Origin header the route's CSRF check needs.
 */
export async function requestLogout(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST", redirect: "manual" });
    const redirected = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    return res.ok || redirected;
  } catch {
    return false;
  }
}
