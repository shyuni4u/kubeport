import { NextRequest } from "next/server";
import { proxyApi } from "@/lib/bff-proxy";
import { getSession } from "@/lib/session";

function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxyApi(req, ctx, getSession);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };