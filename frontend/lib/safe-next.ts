// Where to send someone after they log in.
//
// The value starts life as a pathname the proxy read off an unauthenticated
// request, travels through the OIDC round trip, and ends up in a redirect. A
// redirect target that came from the request is an open redirect unless it is
// checked, and "starts with /" is not the check — `//evil.example` and
// `/\evil.example` are both protocol-relative URLs that browsers resolve to
// another origin.
//
// So: parse it against a throwaway base and require that it still points at
// that base. Anything that escapes, or that is not a page, becomes null and
// the caller falls back to its own default.

const FALLBACK_BASE = "https://kubeport.invalid";

// Long enough for any real route, short enough that it cannot be used to pad
// a cookie or a log line.
const MAX_LENGTH = 512;

// C0 controls, space, and DEL. A newline can split a header or forge a log
// line and no real path carries one. Checked before parsing, because URL()
// strips some of these silently — which would let a value pass the check in a
// different shape than the one that was written down. Written as codepoint
// comparisons rather than a regex so the control characters it rejects do not
// have to appear literally in this file.
function hasUnsafeChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reduce a caller-supplied `next` to a same-origin page path, or null.
 *
 * Returns the path with its query string and no origin — callers build the
 * absolute URL against the origin they actually serve.
 */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_LENGTH) return null;
  if (hasUnsafeChar(raw)) return null;
  if (!raw.startsWith("/")) return null;

  let url: URL;
  try {
    url = new URL(raw, FALLBACK_BASE);
  } catch {
    return null;
  }
  // The escape hatches: `//host`, `/\host`, and anything carrying its own
  // scheme all resolve to a different origin than the base we supplied.
  if (url.origin !== FALLBACK_BASE) return null;

  // /api/* is the machine surface and the auth routes themselves. Sending a
  // freshly logged-in browser there yields JSON, a download, or — for
  // /api/auth/logout — an immediate round trip back out of the session that
  // was just created.
  if (url.pathname.startsWith("/api/")) return null;

  // Landing is every caller's fallback already, so returning it would be a
  // no-op whose only effect is to keep `?next=` in the address bar.
  if (url.pathname === "/") return null;

  // Check the string we are about to RETURN, not the one we were given.
  //
  // Parsing normalizes, and normalization can manufacture an escape that was
  // not in the input: `/a/..//evil.example` parses with this base's origin —
  // so every check above passes — and comes out with its pathname collapsed to
  // `//evil.example`, which is protocol-relative. Resolved again by the
  // callback or an href, that is https://evil.example. Validating the input
  // and returning the normalized form meant checking a different value than
  // the one that gets used. Found by codex review of this change.
  const path = `${url.pathname}${url.search}`;
  if (new URL(path, FALLBACK_BASE).origin !== FALLBACK_BASE) return null;

  return path;
}
