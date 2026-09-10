import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

// #41: an unauthenticated page request went straight to /api/auth/login, which
// goes straight to Google's account picker. The demo's "try it" buttons live on
// the landing page, so anyone arriving on a deep link or a stale bookmark never
// saw them — they were asked to pick an account they do not have.

function req(path: string, opts?: { session?: boolean }) {
  const r = new NextRequest(new URL(`https://kubeport.enzo.kr${path}`));
  if (opts?.session) r.cookies.set("kbp_sid", "abc");
  return r;
}

const DEMO_ENV = {
  DEMO_OIDC_ISSUER: "https://dex.example",
  DEMO_OIDC_CLIENT_ID: "kubeport-demo",
  DEMO_OIDC_CLIENT_SECRET: "shh",
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    DEMO_OIDC_ISSUER: process.env.DEMO_OIDC_ISSUER,
    DEMO_OIDC_CLIENT_ID: process.env.DEMO_OIDC_CLIENT_ID,
    DEMO_OIDC_CLIENT_SECRET: process.env.DEMO_OIDC_CLIENT_SECRET,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withDemo(on: boolean) {
  for (const k of Object.keys(DEMO_ENV)) delete process.env[k];
  if (on) Object.assign(process.env, DEMO_ENV);
}

describe("proxy redirect", () => {
  it("lets a request with a session through", () => {
    withDemo(true);
    const res = proxy(req("/catalog", { session: true }));
    expect(res.headers.get("location")).toBeNull();
  });

  describe("with a demo IdP configured", () => {
    beforeEach(() => withDemo(true));

    it("sends an unauthenticated visitor to landing, not to the IdP", () => {
      const loc = new URL(proxy(req("/catalog")).headers.get("location")!);
      expect(loc.pathname).toBe("/");
      expect(loc.searchParams.get("next")).toBe("/catalog");
    });

    it("remembers the whole path, query included", () => {
      const loc = new URL(proxy(req("/catalog?tag=db")).headers.get("location")!);
      expect(loc.searchParams.get("next")).toBe("/catalog?tag=db");
    });

    it("stays on this origin", () => {
      const loc = new URL(proxy(req("/releases/abc")).headers.get("location")!);
      expect(loc.origin).toBe("https://kubeport.enzo.kr");
    });
  });

  describe("without a demo IdP", () => {
    beforeEach(() => withDemo(false));

    // Nothing to choose between, so bouncing through landing would only add a
    // click to every deep link on a self-hosted install. It still carries the
    // destination, which it did not before.
    it("goes straight to the IdP, carrying the destination", () => {
      const loc = new URL(proxy(req("/catalog")).headers.get("location")!);
      expect(loc.pathname).toBe("/api/auth/login");
      expect(loc.searchParams.get("next")).toBe("/catalog");
    });
  });
});
