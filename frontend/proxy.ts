import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Pages get redirected to the login screen when there is no session cookie.
// The whole /api/ surface is excluded on purpose: /api/v1/* is the machine
// API, and its route handler answers with a JSON 401 that a script can branch
// on. Redirecting it instead sends clients to Google's consent HTML, which
// comes back 200 and reads as success (#24).
export const config = {
  matcher: ["/((?!api/|_next|favicon.ico|$).*)"],
};

export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("kbp_sid");
  if (!hasSession) {
    const url = new URL("/api/auth/login", req.nextUrl.origin);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
