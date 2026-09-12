/**
 * Security headers for every response (#50, #80, #143).
 *
 * They used to live in next.config.ts `headers()`. That runs at `next build`
 * and is baked into the routes manifest, so the chart could not change them:
 * an operator behind a proxy that already sends HSTS, or embedding the app in
 * a portal iframe, had no switch (#80). The proxy reads process.env on every
 * request (Next 16 runs it on the Node.js runtime), which is where the chart's
 * ConfigMap lands — so the headers are built here, from these variables:
 *
 *   SECURITY_HEADERS        "off" drops every header below. Anything else: on.
 *   SECURITY_HSTS           Strict-Transport-Security value. Unset: the default
 *                           below. Empty: no header (a proxy in front sends it).
 *   SECURITY_FRAME_ANCESTORS  CSP frame-ancestors sources. Unset: 'none'.
 *   SECURITY_CSP_MODE       "enforce" (default), "report-only" or "off". Off
 *                           keeps frame-ancestors alone, as before #143.
 *   SECURITY_CSP            A whole policy replacing the default below
 *                           (its own frame-ancestors is dropped and the
 *                           configured one appended).
 *
 * Where they are set: proxy.ts for everything it matches, and
 * `applySecurityHeaders` in the route handlers that answer API requests
 * carrying a body — the proxy deliberately does not match those (see proxy.ts).
 *
 * Import-free on purpose: proxy.ts may not pull in anything heavy (see
 * lib/demo-config).
 */

export const DEFAULT_HSTS = "max-age=63072000; includeSubDomains";

// Stage 1 of #143: stop scripts, styles, frames and connections from foreign
// origins, without nonces yet. Nonces would need every page rendered
// dynamically and each inline script tagged; until then Next's own inline
// bootstrap scripts need 'unsafe-inline'.
//
// Monaco: @monaco-editor/loader fetches the editor from exactly this path at
// runtime — its scripts, stylesheet and codicon font — and runs its language
// workers from blob: URLs. A path, not the whole host: cdn.jsdelivr.net serves
// every npm package, and a host-wide allowlist would hand an attacker script
// gadgets once 'unsafe-inline' goes. security-headers.test.ts fails when the
// loader's own path moves, so an upgrade cannot silently break the editor.
export const MONACO_CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/";

export function defaultCsp(dev: boolean): string {
  return [
    "default-src 'self'",
    // Dev only: React's dev build uses eval for error stacks (Next's CSP guide).
    `script-src 'self' 'unsafe-inline' ${MONACO_CDN}${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline' ${MONACO_CDN}`,
    `font-src 'self' data: ${MONACO_CDN}`,
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    // Dev only: the HMR socket.
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    // Does not fall back to default-src. The app's only forms post to itself:
    // the logout confirmation and Server Actions.
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

type Env = Record<string, string | undefined>;

// A header value may not contain CR, LF or NUL — Headers.set throws on them,
// which in the proxy would turn every response into a 500. A policy written as
// a YAML block in the chart values carries newlines; fold them into spaces.
const clean = (v: string | undefined) => v?.replace(/[\s\0]+/g, " ").trim();

export function securityHeaders(env: Env = process.env): [string, string][] {
  if (env.SECURITY_HEADERS === "off") return [];

  const headers: [string, string][] = [];

  // Two years, no `preload` — submitting to the preload list is an operator's
  // decision. includeSubDomains suits the intended layout (the app plus Dex on
  // its own subdomain, both https) and is wrong on an apex domain with sibling
  // http services, which is what SECURITY_HSTS is for.
  const hsts = env.SECURITY_HSTS === undefined ? DEFAULT_HSTS : clean(env.SECURITY_HSTS);
  if (hsts) headers.push(["Strict-Transport-Security", hsts]);

  headers.push(["X-Content-Type-Options", "nosniff"]);
  headers.push(["Referrer-Policy", "strict-origin-when-cross-origin"]);

  // frame-ancestors rather than X-Frame-Options: the CSP-era spelling. Keeps
  // the login screen and the demo buttons out of foreign iframes.
  const frameAncestors = `frame-ancestors ${clean(env.SECURITY_FRAME_ANCESTORS) || "'none'"}`;
  const mode = env.SECURITY_CSP_MODE || "enforce";
  if (mode === "off") {
    headers.push(["Content-Security-Policy", frameAncestors]);
    return headers;
  }
  // A browser honors the first frame-ancestors in a policy, so one inside a
  // custom SECURITY_CSP would silently win over SECURITY_FRAME_ANCESTORS.
  // Drop it: framing is decided by the dedicated value alone.
  //
  // The relaxed policy only for `next dev` — anything else, NODE_ENV unset
  // included, gets the production one.
  const base = (clean(env.SECURITY_CSP) || defaultCsp(env.NODE_ENV === "development"))
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !/^frame-ancestors(\s|$)/i.test(d))
    .join("; ");
  const policy = `${base}; ${frameAncestors}`;
  if (mode === "report-only") {
    // frame-ancestors is ignored inside Report-Only, so it keeps enforcing on
    // its own header while the rest of the policy is only reported.
    headers.push(["Content-Security-Policy", frameAncestors]);
    headers.push(["Content-Security-Policy-Report-Only", policy]);
  } else {
    headers.push(["Content-Security-Policy", policy]);
  }
  return headers;
}

/** Sets the security headers on a response built by a route handler, and returns it. */
export function applySecurityHeaders<T extends { headers: Headers }>(res: T, env: Env = process.env): T {
  for (const [key, value] of securityHeaders(env)) res.headers.set(key, value);
  return res;
}
