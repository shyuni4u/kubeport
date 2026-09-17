// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { readCliToken } from "@/lib/cli-token";
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), getValidToken: vi.fn() }));
vi.mock("@/lib/session", () => mocks);
import { POST } from "./route";

const origin = "https://selfhost.example";
const sid = "7d84e004-432c-44c0-88cd-4e6669bc4581";
function req(headers: Record<string, string> = {}) {
  return new NextRequest(`${origin}/api/auth/cli-token`, { method: "POST", headers });
}
beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("PUBLIC_ORIGIN", origin);
  mocks.getSession.mockReset().mockResolvedValue({ id: sid });
  mocks.getValidToken.mockReset().mockResolvedValue("oidc-token");
});
afterEach(() => vi.unstubAllEnvs());

describe("CLI credential issuance", () => {
  it("issues only after browser authentication and disables caching", async () => {
    const res = await POST(req({ origin }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.json();
    expect(readCliToken(body.token, origin)).toBe(sid);
    expect(JSON.stringify(body)).not.toContain("oidc-token");
    expect(JSON.stringify(body)).not.toContain(sid);
  });
  it.each([undefined, "https://attacker.example", "null"])("rejects an untrusted or missing Origin", async originHeader => {
    const res = await POST(req(originHeader ? { origin: originHeader } : {}));
    expect(res.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it("does not trust attacker-supplied forwarded headers", async () => {
    expect((await POST(req({ origin: "https://attacker.example", "x-forwarded-host": "attacker.example" }))).status).toBe(403);
  });
  it("refuses issuance with no valid session or OIDC token", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(req({ origin }))).status).toBe(401);
    mocks.getSession.mockResolvedValue({ id: sid });
    mocks.getValidToken.mockResolvedValue(null);
    expect((await POST(req({ origin }))).status).toBe(401);
  });
  it("fails closed in production without a configured origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("OIDC_REDIRECT_URI", "");
    expect((await POST(req({ origin }))).status).toBe(403);
  });
});
