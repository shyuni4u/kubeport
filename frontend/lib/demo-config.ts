/**
 * Whether a demo IdP is configured.
 *
 * Its own module, with no imports, because two callers need it and they cannot
 * share lib/oidc: the proxy would drag openid-client into its bundle for three
 * string comparisons. Two copies of the check would be worse than the import —
 * if they ever disagreed, the proxy would route visitors to a landing page
 * whose demo buttons are not there, which is the bug #41 is about.
 *
 * Reading process.env here is safe in both places: Next 16 runs Proxy on the
 * Node.js runtime, so these resolve at request time from the container's
 * environment. Under the old Edge runtime they would have been inlined at build
 * time — and Helm supplies them at runtime, so the check would have read false
 * in production and the demo would have kept bouncing to Google.
 */
export function demoConfigured(): boolean {
  return Boolean(
    process.env.DEMO_OIDC_ISSUER &&
      process.env.DEMO_OIDC_CLIENT_ID &&
      process.env.DEMO_OIDC_CLIENT_SECRET,
  );
}
