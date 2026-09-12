import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Import-free modules on purpose — see lib/demo-config.
import { demoConfigured } from "@/lib/demo-config";
import { SESSION_COOKIE } from "@/lib/cookie-names";
import { securityHeaders } from "@/lib/security-headers";

// Every request comes through here, because the security headers belong on
// every response: pages, /_next/static, the /api BFF (healthz included), 404s
// and redirects. They moved here from next.config.ts `headers()`, which is
// baked at build time and so could not follow the chart's values (#80).
export const config = {
  matcher: ["/:path*"],
};

// Only pages redirect to login when there is no session cookie — the paths the
// old matcher named. The whole /api/ surface is excluded on purpose: /api/v1/*
// is the machine API, and its route handler answers with a JSON 401 that a
// script can branch on. Redirecting it instead sends clients to Google's
// consent HTML, which comes back 200 and reads as success (#24).
//
// /logout is excluded too — it is the confirmation screen behind
// GET /api/auth/logout, and it has to be able to say "you are already logged
// out" rather than bounce a logged-out visitor into a login flow (#28). So are
// "/" (the landing page) and Next's own assets.
const LOGIN_GUARDED = /^\/(?!api\/|_next|favicon\.ico|logout$|$)/;

function withSecurityHeaders(res: NextResponse): NextResponse {
  for (const [key, value] of securityHeaders()) res.headers.set(key, value);
  return res;
}

export function proxy(req: NextRequest) {
  return withSecurityHeaders(route(req));
}

function route(req: NextRequest): NextResponse {
  if (!LOGIN_GUARDED.test(req.nextUrl.pathname)) return NextResponse.next();
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (hasSession) return NextResponse.next();

  // Where they were trying to go, so the round trip can put them back there
  // instead of on the catalog. Only the path — the origin is this request's.
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;

  // With a demo IdP configured there is a CHOICE to present, and sending the
  // visitor straight to Google hides it: the demo buttons live on the landing
  // page, so anyone arriving on a deep link or a stale bookmark never saw
  // them and met an account picker for an account they do not have (#41).
  //
  // Without one there is nothing to choose, and bouncing through landing would
  // just add a click to every deep link on a self-hosted install — so that
  // case keeps going straight to the IdP, now carrying `next` as well.
  const target = demoConfigured()
    ? new URL("/", req.nextUrl.origin)
    : new URL("/api/auth/login", req.nextUrl.origin);
  target.searchParams.set("next", next);
  return NextResponse.redirect(target);
}
