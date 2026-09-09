import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { allowedOrigins, externalOrigin, isAllowedOrigin } from "./request-origin";

const ORIGINAL = {
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A request as it arrives at the Next server behind the ingress. */
function req(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/auth/logout", { headers });
}

describe("externalOrigin", () => {
  it("returns the forwarded origin when it is the configured public one", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr";
    expect(
      externalOrigin(
        req({ "x-forwarded-host": "kubeport.enzo.kr", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://kubeport.enzo.kr");
  });

  // The headers are attacker-controlled for anything that can reach the Next
  // service directly (a sidecar, another pod, an SSRF that lands in-cluster).
  // A forged host must never become a redirect target.
  it("ignores a forged x-forwarded-host", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr";
    expect(
      externalOrigin(
        req({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://kubeport.enzo.kr");
  });

  it("ignores a forged proto downgrade", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr";
    expect(
      externalOrigin(
        req({ "x-forwarded-host": "kubeport.enzo.kr", "x-forwarded-proto": "http" }),
      ),
    ).toBe("https://kubeport.enzo.kr");
  });

  it("ignores a forged Host when x-forwarded-host is absent", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr";
    expect(externalOrigin(req({ host: "evil.example" }))).toBe("https://kubeport.enzo.kr");
  });

  it("falls back to the origin of OIDC_REDIRECT_URI", () => {
    delete process.env.PUBLIC_ORIGIN;
    process.env.OIDC_REDIRECT_URI = "https://kubeport.enzo.kr/api/auth/callback";
    expect(externalOrigin(req({ "x-forwarded-host": "evil.example" }))).toBe(
      "https://kubeport.enzo.kr",
    );
  });

  it("accepts any origin from a comma-separated PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr, https://staging.kubeport.enzo.kr";
    expect(
      externalOrigin(
        req({ "x-forwarded-host": "staging.kubeport.enzo.kr", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://staging.kubeport.enzo.kr");
    // …and still pins anything else to the first entry.
    expect(externalOrigin(req({ "x-forwarded-host": "evil.example" }))).toBe(
      "https://kubeport.enzo.kr",
    );
  });

  // Local dev without either variable keeps working off the request headers —
  // there is no allowlist to check against, and nothing is proxying.
  it("derives from headers when no public origin is configured", () => {
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.OIDC_REDIRECT_URI;
    expect(externalOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });

  it("ignores a malformed OIDC_REDIRECT_URI instead of throwing", () => {
    delete process.env.PUBLIC_ORIGIN;
    process.env.OIDC_REDIRECT_URI = "not a url";
    expect(externalOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
});

describe("allowedOrigins / isAllowedOrigin", () => {
  it("is empty when nothing is configured", () => {
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.OIDC_REDIRECT_URI;
    expect(allowedOrigins()).toEqual([]);
    // With no allowlist the caller has to fall back to its own check.
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
  });

  it("matches configured origins only", () => {
    process.env.PUBLIC_ORIGIN = "https://kubeport.enzo.kr";
    expect(isAllowedOrigin("https://kubeport.enzo.kr")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("http://kubeport.enzo.kr")).toBe(false);
  });
});
