import { NextRequest } from "next/server";
import { requestIdFor } from "@/lib/bff-path";
import { bffProblem } from "@/lib/bff-problem";

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

export {
  root as GET,
  root as POST,
  root as PUT,
  root as PATCH,
  root as DELETE,
};
