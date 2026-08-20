import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const config = {
  matcher: ["/((?!api/auth|_next|favicon.ico|$).*)"],
};

export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("kbp_sid");
  if (!hasSession) {
    const url = new URL("/api/auth/login", req.nextUrl.origin);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
