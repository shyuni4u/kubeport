import { NextRequest } from "next/server";
import { requestIdFor } from "@/lib/bff-path";
import { bffProblem } from "@/lib/bff-problem";
import { applySecurityHeaders } from "@/lib/security-headers";

/**
 * `/api/v1` with no path segments.
 *
 * The proxy next door is `[...path]`, which requires at least one segment, so
 * probing the API root fell through to Next's own HTML 404 — the one surface
 * of `/api/v1` that answered in neither the Problem schema nor JSON at all
 * (issue #81). Poking the root is exactly what a client does when it is trying
 * to discover the API, so it is a bad place to hand back a web page.
 *
 * No session check: this path leads nowhere regardless of who is asking, and
 * answering 401 first would imply there is something here to reach.
 */
function root(req: NextRequest) {
  return bffProblem(
    "not-found",
    404,
    "no route matches this path; the API is served under /api/v1/<resource>",
    requestIdFor(req.headers),
  );
}

// The security headers are set here as well as in proxy.ts: a request with a
// body is not matched by the proxy (see proxy.ts), so for POST/PUT/PATCH this
// is the only place they come from.
function handler(req: NextRequest) {
  return applySecurityHeaders(root(req));
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
