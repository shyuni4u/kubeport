import { NextRequest } from "next/server";
import { proxyApi } from "@/lib/bff-proxy";
import { readCliToken } from "@/lib/cli-token";
import { getSessionById } from "@/lib/session";
import { externalOrigin } from "@/lib/request-origin";

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const response = await proxyApi(req, ctx, async () => {
    const authorization = req.headers.get("authorization") ?? "";
    const match = /^Bearer (kbp_cli_[A-Za-z0-9_-]{40,1024})$/i.exec(authorization);
    if (!match) return null;
    const id = readCliToken(match[1], externalOrigin(req));
    return id ? getSessionById(id) : null;
  }, "CLI credential is missing, expired or revoked; sign in again");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
