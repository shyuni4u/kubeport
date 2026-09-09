import type { NextRequest } from "next/server";

/**
 * The origins this deployment is served on.
 *
 * `PUBLIC_ORIGIN` wins (comma-separated for multi-domain deploys); otherwise we
 * derive it from `OIDC_REDIRECT_URI`, which already has to be the exact public
 * URL because the IdP matches it byte for byte. Read per call rather than at
 * module load so the value tracks the environment in tests and in dev.
 *
 * An empty list means "not configured" — local development typically has
 * neither variable, and there is no proxy in front to lie about the host.
 */
export function allowedOrigins(): string[] {
  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) {
    return configured
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean);
  }
  const redirect = process.env.OIDC_REDIRECT_URI;
  if (redirect) {
    try {
      return [new URL(redirect).origin];
    } catch {
      // Misconfigured env shouldn't take the app down; fall through to "not
      // configured" and let the header-derived value stand.
      return [];
    }
  }
  return [];
}

/** Whether `origin` is one of this deployment's public origins. */
export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins().includes(origin);
}

/**
 * The externally visible origin of this deployment.
 *
 * Behind a TLS-terminating reverse proxy (traefik/ingress), the Next standalone
 * server sees the request on its internal bind address, so `req.nextUrl.origin`
 * resolves to e.g. `https://0.0.0.0:3000` instead of the public URL — hence the
 * forwarded headers.
 *
 * Those headers are attacker-controlled for anything that can reach the Next
 * service directly (a sidecar, another pod, an SSRF landing in-cluster), and
 * this value decides where we send a user after login and logout. So the
 * derived origin is only honoured when it is one we actually serve; otherwise
 * we pin to the first configured origin. With nothing configured (local dev)
 * the derived value stands, because there is no proxy to lie about it.
 */
export function externalOrigin(req: NextRequest): string {
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.host;
  const proto =
    req.headers.get("x-forwarded-proto") ??
    req.nextUrl.protocol.replace(/:$/, "");
  const derived = `${proto}://${host}`;

  const allowed = allowedOrigins();
  if (allowed.length === 0) return derived;
  return allowed.includes(derived) ? derived : allowed[0];
}
