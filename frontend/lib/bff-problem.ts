import { NextResponse } from "next/server";

/**
 * A Problem the BFF answers itself, carrying the same id as the log.
 *
 * Same shape as the Go API's Problem (backend/internal/api/errors.go), so a
 * client parses one schema across the whole /api/v1 surface (#56). Shared
 * between the catch-all proxy and the bare `/api/v1` route, which Next's
 * `[...path]` segment does not match — that one used to fall through to Next's
 * own HTML 404 (#81).
 */
export function bffProblem(
  kind: string,
  status: number,
  detail: string,
  requestId: string,
): NextResponse {
  return NextResponse.json(
    {
      type: `https://kubeport.io/errors/${kind}`,
      title: kind,
      status,
      detail,
      request_id: requestId,
    },
    { status, headers: { "X-Request-Id": requestId } },
  );
}
