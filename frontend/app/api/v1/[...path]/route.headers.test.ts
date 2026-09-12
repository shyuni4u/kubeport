// @vitest-environment node
// See route.test.ts for why this runs under node.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.fn();
const getValidToken = vi.fn();
vi.mock("@/lib/session", () => ({
  getSession: () => getSession(),
  getValidToken: (s: unknown) => getValidToken(s),
}));

import { GET, POST } from "./route";

const fetchMock = vi.fn();

beforeEach(() => {
  getSession.mockReset();
  getValidToken.mockReset();
  fetchMock.mockReset();
  getSession.mockResolvedValue({ id: "s1" });
  getValidToken.mockResolvedValue("id-token");
  fetchMock.mockResolvedValue(new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GO_API_BASE_URL", "http://backend:8080");
  vi.stubEnv("NODE_ENV", "production");
});

const params = { params: Promise.resolve({ path: ["templates"] }) };

function post(body = "{}") {
  return new NextRequest(new URL("https://kubeport.enzo.kr/api/v1/templates"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
    body,
  });
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
}

// #80 security review: proxy.ts no longer matches /api requests with a body
// (Next would clone and wait for the body before the session check, #128), so
// for those the handler is the only source of the security headers.
describe("BFF proxy — security headers on responses the proxy does not see", () => {
  it("sets them on a proxied POST", async () => {
    const res = await POST(post(), params);
    expect(res.status).toBe(201);
    expectSecurityHeaders(res);
  });

  it("sets them on the 401 for a caller without a session", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(post(), params);
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it("sets them on the 413 for an oversized body, still refused before forwarding", async () => {
    const big = "x".repeat((4 << 20) + 1);
    const res = await POST(post(big), params);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    expectSecurityHeaders(res);
  });

  it("sets them on GET as well", async () => {
    const res = await GET(new NextRequest(new URL("https://kubeport.enzo.kr/api/v1/templates")), params);
    expectSecurityHeaders(res);
  });
});
