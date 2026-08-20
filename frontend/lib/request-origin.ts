import type { NextRequest } from "next/server";

// Behind a TLS-terminating reverse proxy (traefik/ingress), the Next standalone
// server sees the request on its internal bind address, so `req.nextUrl.origin`
// resolves to e.g. `https://0.0.0.0:3000` instead of the public URL. Derive the
// externally visible origin from the proxy's forwarded headers so redirects and
// same-origin checks use the real host the browser is talking to.
export function externalOrigin(req: NextRequest): string {
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.host;
  const proto =
    req.headers.get("x-forwarded-proto") ??
    req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}
