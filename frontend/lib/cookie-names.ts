/**
 * Names and attributes of the two auth cookies (#165).
 *
 * `__Host-` makes the browser refuse any version of the cookie that carries a
 * Domain attribute, lacks Secure, or has a Path other than "/". That is what
 * stops a sibling host from planting one: Dex runs on a subdomain of the app
 * (dex.<app-host>), and without the prefix anything that can answer there could
 * send `Set-Cookie: kbp_oidc_state=...; Domain=<app-host>` and choose the
 * state, nonce and PKCE verifier the callback trusts — a login CSRF. httpOnly
 * does not help (it stops reading, not overwriting) and neither does
 * sameSite=lax (a subdomain is the same site).
 *
 * The prefix needs Secure, and Secure cookies only work over https (browsers
 * make an exception for http://localhost). `pnpm dev` and the e2e runs serve
 * plain http, so the prefix follows the same switch as `secure` already did.
 *
 * Renaming invalidates every live session on deploy: browsers still hold
 * `kbp_sid`, nothing reads it any more, and each visitor signs in again.
 *
 * Deleting needs the same attributes as setting. Next's `cookies().delete(name)`
 * sends only the name and an expired date — no Secure — and a browser drops a
 * `__Host-` Set-Cookie without Secure, so the cookie would silently survive
 * logout. Use `clearAuthCookie`.
 */

const secure = process.env.NODE_ENV === "production";
const prefix = secure ? "__Host-" : "";

export const SESSION_COOKIE = `${prefix}kbp_sid`;
export const OIDC_STATE_COOKIE = `${prefix}kbp_oidc_state`;

/** Attributes every auth cookie is set with. `__Host-` requires exactly these: Secure, Path=/, no Domain. */
export const AUTH_COOKIE_ATTRS = {
  httpOnly: true,
  secure,
  sameSite: "lax",
  path: "/",
} as const;

type CookieWriter = {
  delete(options: { name: string } & typeof AUTH_COOKIE_ATTRS): unknown;
};

/** Expire an auth cookie with the attributes it was set with, so a `__Host-` deletion is not rejected. */
export function clearAuthCookie(store: CookieWriter, name: string) {
  store.delete({ name, ...AUTH_COOKIE_ATTRS });
}
