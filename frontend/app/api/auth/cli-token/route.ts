import { NextRequest, NextResponse } from "next/server";
import { getSession, getValidToken } from "@/lib/session";
import { issueCliToken } from "@/lib/cli-token";
import { allowedOrigins, externalOrigin } from "@/lib/request-origin";
import { requestIdFor } from "@/lib/bff-path";
import { bffProblem } from "@/lib/bff-problem";
import { applySecurityHeaders } from "@/lib/security-headers";

export async function POST(req: NextRequest) {
  const requestId = requestIdFor(req.headers);
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins();
  // Fail closed when production has no trusted public origin configured.
  const acceptable = allowed.length ? allowed :
    process.env.NODE_ENV !== "production" ? [externalOrigin(req)] : [];
  let response: NextResponse;
  if (!origin || !acceptable.includes(origin)) {
    response = bffProblem("forbidden", 403, "cross-origin request rejected", requestId);
  } else {
    try {
      const session = await getSession();
      if (!session || !await getValidToken(session)) {
        response = bffProblem("unauthenticated", 401, "sign in again before connecting a CLI", requestId);
      } else {
        response = NextResponse.json(issueCliToken(session.id, origin), {
          headers: { "X-Request-Id": requestId },
        });
      }
    } catch {
      // Never log a credential, session ID, or raw token exchange error.
      console.error(`cli credential issuance failed id=${requestId}`);
      response = bffProblem("internal", 500, "could not create a CLI credential", requestId);
    }
  }
  response.headers.set("Cache-Control", "no-store");
  return applySecurityHeaders(response);
}
