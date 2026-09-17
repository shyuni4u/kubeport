// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { issueCliToken } from "@/lib/cli-token";
const mocks = vi.hoisted(() => ({ getSessionById: vi.fn(), getSession: vi.fn(), getValidToken: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/session", () => mocks);
import { GET, POST } from "./route";

const origin = "https://selfhost.example";
const sid = "7d84e004-432c-44c0-88cd-4e6669bc4581";
const ctx = { params: Promise.resolve({ path: ["me"] }) };
function req(token?: string, method = "GET", body?: string) {
  return new NextRequest(`${origin}/api/cli/v1/me`, {
    method, body, headers: token ? { authorization: `Bearer ${token}`, cookie: "kbp_sid=not-a-cli-token" } : {},
  });
}
beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("PUBLIC_ORIGIN", origin);
  vi.stubEnv("GO_API_BASE_URL", "http://backend:8080");
  mocks.getSessionById.mockReset().mockResolvedValue({ id: sid });
  mocks.getSession.mockReset();
  mocks.getValidToken.mockReset().mockResolvedValue("real-user-oidc-token");
  mocks.fetch.mockReset().mockImplementation(async () => new Response('{"email":"user@example.org"}', { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("CLI API entry point", () => {
  it("passes the session's OIDC identity downstream, never the CLI credential or cookie", async () => {
    const { token } = issueCliToken(sid, origin);
    const res = await GET(req(token), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getSessionById).toHaveBeenCalledWith(sid);
    expect(mocks.getSession).not.toHaveBeenCalled();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("http://backend:8080/v1/me");
    expect(options.headers.Authorization).toBe("Bearer real-user-oidc-token");
    expect(JSON.stringify(options)).not.toContain(token);
    expect(options.headers.cookie).toBeUndefined();
  });
  it("rejects a browser cookie, raw session ID, OIDC token or expired CLI token", async () => {
    for (const token of [undefined, sid, "real-user-oidc-token", issueCliToken(sid, origin, Date.now() - 3_600_001).token]) {
      expect((await GET(req(token), ctx)).status).toBe(401);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getSessionById).not.toHaveBeenCalled();
  });
  it("rejects a revoked or expired browser session", async () => {
    mocks.getSessionById.mockResolvedValue(null);
    expect((await GET(req(issueCliToken(sid, origin).token), ctx)).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects a token for a different installation", async () => {
    expect((await GET(req(issueCliToken(sid, "https://other.example").token), ctx)).status).toBe(401);
    expect(mocks.getSessionById).not.toHaveBeenCalled();
  });
  it("retains the existing path validation and request body cap", async () => {
    const { token } = issueCliToken(sid, origin);
    expect((await GET(req(token), { params: Promise.resolve({ path: ["..", "healthz"] }) })).status).toBe(400);
    const res = await POST(req(token, "POST", "x".repeat(4 * 1024 * 1024 + 1)), ctx);
    expect(res.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves permission errors and request IDs from the backend", async () => {
    mocks.fetch.mockResolvedValue(new Response('{"title":"forbidden","request_id":"trace"}', { status: 403, headers: { "X-Request-Id": "trace" } }));
    const res = await GET(req(issueCliToken(sid, origin).token), ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("trace");
    expect((await res.json()).title).toBe("forbidden");
  });
});
