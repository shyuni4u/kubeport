// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async () => ({ id: "s1" })),
  destroySession: vi.fn(async () => {}),
}));
vi.mock("@/lib/request-origin", () => ({
  allowedOrigins: () => ["https://kubeport.enzo.kr"],
  externalOrigin: () => "https://kubeport.enzo.kr",
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
}

// #80 security review: the user menu's logout POST carries a body length, so
// proxy.ts does not match it; the route sets the headers itself.
describe("logout — security headers", () => {
  it("sets them on the POST's 303", async () => {
    const res = await POST(
      new NextRequest(new URL("https://kubeport.enzo.kr/api/auth/logout"), {
        method: "POST",
        headers: { Origin: "https://kubeport.enzo.kr", "Content-Length": "0" },
      }),
    );
    expect(res.status).toBe(303);
    expectSecurityHeaders(res);
  });

  it("sets them on the cross-origin 403", async () => {
    const res = await POST(
      new NextRequest(new URL("https://kubeport.enzo.kr/api/auth/logout"), {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it("sets them on the GET redirect", async () => {
    const res = await GET(new NextRequest(new URL("https://kubeport.enzo.kr/api/auth/logout")));
    expect(res.status).toBe(303);
    expectSecurityHeaders(res);
  });
});
