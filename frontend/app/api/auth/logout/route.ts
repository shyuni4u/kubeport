import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { allowedOrigins, externalOrigin } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  // Second line of defence behind the session cookie's SameSite=lax. Compare
  // the browser-set Origin against the origins we actually serve — comparing
  // it to a value derived from the request's own forwarded headers let a
  // caller that controls both headers satisfy the check trivially.
  // A missing Origin is rejected too: browsers always send it on a non-GET
  // fetch, and the only caller is TopBarUserMenu's POST, so requiring it costs
  // nothing and closes the "no header, no check" hole.
  const origin = req.headers.get("origin");
  const allowed = allowedOrigins();
  const acceptable = allowed.length > 0 ? allowed : [externalOrigin(req)];
  if (!origin || !acceptable.includes(origin)) {
    return new NextResponse("cross-origin request rejected", { status: 403 });
  }
  await destroySession();
  // 303 See Other so the browser follows the POST-logout with a GET to "/".
  // A default 307 would re-POST to "/", leaving the user on a re-submitted
  // home render with no visible navigation ("logout does nothing").
  return NextResponse.redirect(new URL("/", externalOrigin(req)), 303);
}
