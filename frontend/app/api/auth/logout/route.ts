import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { externalOrigin } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && origin !== externalOrigin(req)) {
    return new NextResponse("cross-origin request rejected", { status: 403 });
  }
  await destroySession();
  // 303 See Other so the browser follows the POST-logout with a GET to "/".
  // A default 307 would re-POST to "/", leaving the user on a re-submitted
  // home render with no visible navigation ("logout does nothing").
  return NextResponse.redirect(new URL("/", externalOrigin(req)), 303);
}
