import { describe, expect, it } from "vitest";

import { DEFAULT_HSTS, defaultCsp, securityHeaders } from "./security-headers";

const prod = { NODE_ENV: "production" };
const asMap = (h: [string, string][]) => Object.fromEntries(h);

describe("securityHeaders defaults", () => {
  // These three are what production sent before the headers moved out of
  // next.config.ts (#50). The move must not change them by a byte.
  it("keeps the pre-#80 HSTS, nosniff and Referrer-Policy exactly", () => {
    const h = asMap(securityHeaders(prod));
    expect(h["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    expect(DEFAULT_HSTS).toBe("max-age=63072000; includeSubDomains");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("enforces the stage-1 CSP with frame-ancestors 'none' last", () => {
    const csp = asMap(securityHeaders(prod))["Content-Security-Policy"];
    expect(csp).toBe(`${defaultCsp(false)}; frame-ancestors 'none'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows eval and the HMR socket only outside production", () => {
    expect(defaultCsp(true)).toContain("'unsafe-eval'");
    expect(defaultCsp(true)).toContain("ws:");
    expect(defaultCsp(false)).not.toContain("ws:");
  });
});

describe("securityHeaders switches (chart values, #80)", () => {
  it("drops everything with SECURITY_HEADERS=off", () => {
    expect(securityHeaders({ ...prod, SECURITY_HEADERS: "off" })).toEqual([]);
  });

  it("omits HSTS when SECURITY_HSTS is empty, and uses a custom value when set", () => {
    expect(asMap(securityHeaders({ ...prod, SECURITY_HSTS: "" }))).not.toHaveProperty("Strict-Transport-Security");
    expect(asMap(securityHeaders({ ...prod, SECURITY_HSTS: "max-age=300" }))["Strict-Transport-Security"]).toBe(
      "max-age=300",
    );
  });

  it("puts SECURITY_FRAME_ANCESTORS in the policy", () => {
    const csp = asMap(securityHeaders({ ...prod, SECURITY_FRAME_ANCESTORS: "https://portal.example.com" }))[
      "Content-Security-Policy"
    ];
    expect(csp).toMatch(/; frame-ancestors https:\/\/portal\.example\.com$/);
  });

  it("report-only reports the policy but still enforces frame-ancestors", () => {
    const h = asMap(securityHeaders({ ...prod, SECURITY_CSP_MODE: "report-only" }));
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["Content-Security-Policy-Report-Only"]).toBe(`${defaultCsp(false)}; frame-ancestors 'none'`);
  });

  it("off sends only frame-ancestors, as before #143", () => {
    const h = asMap(securityHeaders({ ...prod, SECURITY_CSP_MODE: "off" }));
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h).not.toHaveProperty("Content-Security-Policy-Report-Only");
  });

  it("SECURITY_CSP replaces the default policy and keeps frame-ancestors", () => {
    const csp = asMap(securityHeaders({ ...prod, SECURITY_CSP: "default-src 'none'" }))["Content-Security-Policy"];
    expect(csp).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  // Browsers honor the first frame-ancestors, so a custom policy's own would
  // otherwise override the configured one and reopen framing.
  it("drops a frame-ancestors inside SECURITY_CSP in favour of SECURITY_FRAME_ANCESTORS", () => {
    const csp = asMap(
      securityHeaders({ ...prod, SECURITY_CSP: "default-src 'self'; Frame-Ancestors *; img-src 'self';" }),
    )["Content-Security-Policy"];
    expect(csp).toBe("default-src 'self'; img-src 'self'; frame-ancestors 'none'");
    expect(csp.match(/frame-ancestors/gi)).toHaveLength(1);
  });
});
