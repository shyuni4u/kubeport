import { describe, expect, it } from "vitest";

import { config } from "./proxy";

// Next.js compiles each matcher string with path-to-regexp, not the RegExp
// constructor, so this is an approximation — it pins the intent of the pattern,
// not Next's exact matching. The real behaviour was checked by running the app:
// GET /api/v1/templates returns a JSON 401 while GET /catalog still 307s to
// /api/auth/login. Treat a change here as a prompt to re-check that by hand.
function intercepts(pathname: string): boolean {
  return config.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));
}

describe("middleware matcher", () => {
  // #24: the middleware answers unauthenticated requests with a 307 to the
  // login page. That is right for a browser hitting a page, and wrong for
  // /api/v1/*, where a script or agent needs a JSON 401 it can branch on —
  // following the redirect lands on Google's consent HTML with status 200,
  // which naive clients read as success.
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
});
