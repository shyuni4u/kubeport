import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { config, proxy } from "./proxy";

// Security review of #80: a Node proxy makes Next clone the request body and
// wait for the whole upload before the route handler runs. The BFF's #128
// (no body read before the session check) and #266 (4 MiB cap while
// streaming) depend on /api requests with a body never being matched.
describe("proxy matcher", () => {
  it("matches /api only for requests without a body", () => {
    const api = config.matcher.find((m) => typeof m === "object" && m.source === "/api/:path*");
    expect(api).toBeDefined();
    expect(api && typeof api === "object" ? api.missing : undefined).toEqual([
      { type: "header", key: "content-length" },
      { type: "header", key: "transfer-encoding" },
    ]);
    // And no other entry reaches /api unconditionally.
    for (const m of config.matcher) {
      if (typeof m === "string") expect(new RegExp(`^${m}$`).test("/api/v1/templates")).toBe(false);
    }
  });
});

// #80: the security headers moved from next.config.ts into the proxy, so the
// proxy now has to put them on every response — including the ones it does
// not redirect (the API, Next's assets, the landing page) and the redirect it
// makes itself. A path that slips past means HSTS and nosniff silently vanish
// from it.

function req(path: string) {
  return new NextRequest(new URL(`https://kubeport.enzo.kr${path}`));
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy security headers", () => {
  it.each([
    ["the landing page", "/"],
    ["the BFF API", "/api/healthz"],
    ["the machine API", "/api/v1/templates"],
    ["a Next static asset", "/_next/static/chunks/main.js"],
    ["the logout screen", "/logout"],
    ["an unknown path (404)", "/no-such-page"],
  ])("sets them on %s", (_label, path) => {
    const res = proxy(req(path));
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("sets them on the login redirect it makes itself", () => {
    const res = proxy(req("/catalog"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("does not redirect the API, assets or landing to login (the old matcher's exclusions)", () => {
    for (const path of ["/", "/api/v1/templates", "/_next/static/x.js", "/favicon.ico", "/logout"]) {
      expect(proxy(req(path)).headers.get("location"), path).toBeNull();
    }
  });

  it("follows SECURITY_HEADERS=off at request time", () => {
    vi.stubEnv("SECURITY_HEADERS", "off");
    const res = proxy(req("/api/healthz"));
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
