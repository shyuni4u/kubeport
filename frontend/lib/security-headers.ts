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
 *                           (frame-ancestors is still appended).
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
// cdn.jsdelivr.net is Monaco: @monaco-editor/loader fetches the editor from
// https://cdn.jsdelivr.net/npm/monaco-editor@<version>/min/vs at runtime —
// its scripts, stylesheet and codicon font — and runs its language workers
// from blob: URLs.
const CDN = "https://cdn.jsdelivr.net";

export function defaultCsp(dev: boolean): string {
  return [
    "default-src 'self'",
    // Dev only: React's dev build uses eval for error stacks (Next's CSP guide).
    `script-src 'self' 'unsafe-inline' ${CDN}${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline' ${CDN}`,
    `font-src 'self' data: ${CDN}`,
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    // Dev only: the HMR socket.
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

type Env = Record<string, string | undefined>;

export function securityHeaders(env: Env = process.env): [string, string][] {
  if (env.SECURITY_HEADERS === "off") return [];

  const headers: [string, string][] = [];

  // Two years, no `preload` — submitting to the preload list is an operator's
  // decision. includeSubDomains suits the intended layout (the app plus Dex on
  // its own subdomain, both https) and is wrong on an apex domain with sibling
  // http services, which is what SECURITY_HSTS is for.
  const hsts = env.SECURITY_HSTS ?? DEFAULT_HSTS;
  if (hsts !== "") headers.push(["Strict-Transport-Security", hsts]);

  headers.push(["X-Content-Type-Options", "nosniff"]);
  headers.push(["Referrer-Policy", "strict-origin-when-cross-origin"]);

  // frame-ancestors rather than X-Frame-Options: the CSP-era spelling. Keeps
  // the login screen and the demo buttons out of foreign iframes.
  const frameAncestors = `frame-ancestors ${env.SECURITY_FRAME_ANCESTORS || "'none'"}`;
  const mode = env.SECURITY_CSP_MODE || "enforce";
  if (mode === "off") {
    headers.push(["Content-Security-Policy", frameAncestors]);
    return headers;
  }
  const policy = `${env.SECURITY_CSP || defaultCsp(env.NODE_ENV !== "production")}; ${frameAncestors}`;
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
