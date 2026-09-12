import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

// The proxy now runs on every path (#80 — it sets the security headers), so
// which paths are login-guarded is decided inside it, not by the matcher.
// These drive the real function with no session cookie and read whether it
// answered with a redirect. The behaviour pinned is the same as when the
// matcher itself excluded these paths.
function intercepts(pathname: string): boolean {
  const res = proxy(new NextRequest(new URL(`https://kubeport.enzo.kr${pathname}`)));
  return res.headers.get("location") !== null;
}

let savedIssuer: string | undefined;

beforeEach(() => {
  // No demo IdP: an unauthenticated page goes straight to /api/auth/login.
  savedIssuer = process.env.DEMO_OIDC_ISSUER;
  delete process.env.DEMO_OIDC_ISSUER;
});

afterEach(() => {
  if (savedIssuer === undefined) delete process.env.DEMO_OIDC_ISSUER;
  else process.env.DEMO_OIDC_ISSUER = savedIssuer;
  vi.unstubAllEnvs();
});

describe("proxy login guard", () => {
  // #24: the proxy answers unauthenticated requests with a 307 to the login
  // page. That is right for a browser hitting a page, and wrong for /api/v1/*,
  // where a script or agent needs a JSON 401 it can branch on — following the
  // redirect lands on Google's consent HTML with status 200, which naive
  // clients read as success.
  it("leaves the JSON API to its route handler", () => {
    expect(intercepts("/api/v1/templates")).toBe(false);
    expect(intercepts("/api/v1/releases/abc/logs")).toBe(false);
    expect(intercepts("/api/auth/login")).toBe(false);
  });

  it("still guards pages", () => {
    expect(intercepts("/catalog")).toBe(true);
    expect(intercepts("/releases")).toBe(true);
    expect(intercepts("/admin/teams")).toBe(true);
    expect(intercepts("/templates/web-app/versions/1/edit")).toBe(true);
  });

  it("skips build assets and the landing page", () => {
    expect(intercepts("/_next/static/chunk.js")).toBe(false);
    expect(intercepts("/favicon.ico")).toBe(false);
    expect(intercepts("/")).toBe(false);
  });

  // #28: /logout is the confirmation screen behind GET /api/auth/logout. Gating
  // it would send a logged-out visitor into a login flow to reach the page
  // whose only job is to end a session — and, with #41's `next` in place, back
  // to the logout screen immediately after signing in.
  it("leaves the logout confirmation open", () => {
    expect(intercepts("/logout")).toBe(false);
    // Only that exact path, though — nothing is meant to hide underneath it.
    expect(intercepts("/logout/anything")).toBe(true);
  });
});
