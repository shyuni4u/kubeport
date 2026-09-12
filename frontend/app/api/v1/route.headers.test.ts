// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

// #80 security re-review: a POST with a body to /api/v1 is not matched by
// proxy.ts (it would clone the body first), so this root route has to set the
// security headers on its own 404 like the catch-all next door does.
describe("/api/v1 root — security headers", () => {
  it.each([
    ["GET", () => GET(new NextRequest(new URL("https://kubeport.enzo.kr/api/v1")))],
    [
      "POST with a body",
      () =>
        POST(
          new NextRequest(new URL("https://kubeport.enzo.kr/api/v1"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": "2" },
            body: "{}",
          }),
        ),
    ],
  ])("sets them on the 404 for %s", async (_label, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
