import { describe, expect, it } from "vitest";

import { apiPathSegment, isSafePathSegment, serverApiUrl, versionSegment } from "./api-path";

// #374 — server pages put decoded route params into Go API paths.
describe("apiPathSegment", () => {
  it.each([
    ["web-app", "web-app"],
    // Names from before #369's rule are still served, so they still open.
    ["WebApp", "WebApp"],
    ["web app", "web%20app"],
    ["web_app", "web_app"],
    ["한글", "%ED%95%9C%EA%B8%80"],
  ])("encodes %j as one segment", (value, encoded) => {
    expect(apiPathSegment(value)).toBe(encoded);
  });

  // What a `%2F` or `%2e%2e` in the URL decodes to.
  it.each(["", ".", "..", "a/b", "a\\b", "../releases/3f2c1a9e"])(
    "refuses %j",
    (value) => {
      expect(isSafePathSegment(value)).toBe(false);
      expect(apiPathSegment(value)).toBeNull();
    },
  );

  // Encoded, a percent sign cannot be decoded again into a dot-segment.
  it("keeps a literal percent-encoded dot-segment inside its segment", () => {
    expect(apiPathSegment("%2e%2e")).toBe("%252e%252e");
  });
});

describe("versionSegment", () => {
  it.each(["1", "12", "2147483647"])("accepts %j", (value) => {
    expect(versionSegment(value)).toBe(value);
  });

  it.each(["", "0", "01", "-1", "1.5", "1e3", " 1", "1/publish", "../x", "12345678901"])(
    "refuses %j",
    (value) => {
      expect(versionSegment(value)).toBeNull();
    },
  );

  it("refuses a missing field and a file", () => {
    expect(versionSegment(null)).toBeNull();
    expect(versionSegment(new File(["1"], "v.txt"))).toBeNull();
  });
});

// #374 — apiFetch's own check, for every server-side call whatever built its path.
describe("serverApiUrl", () => {
  const BASE = "http://kubeport-backend:8080";

  it.each([
    "/v1/me",
    "/v1/templates/web-app/versions/2/publish",
    "/v1/templates/web%20app",
    "/v1/templates/%252e%252e",
    "/v1/templates/%3F",
    "/v1/teams/3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f/members",
  ])("requests %j as given", (path) => {
    expect(serverApiUrl(BASE, path)).toBe(`${BASE}${path}`);
  });

  it.each([
    // Outside /v1/ altogether.
    "/healthz",
    "v1/me",
    "/v1",
    "//evil.example/v1/me",
    // Still under /v1/ once collapsed, but not the route the path names — the
    // prefix alone would let these through.
    "/v1/templates/../releases/3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f",
    "/v1/templates/%2e%2e/releases/3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f",
    "/v1/templates/web-app/versions/./1",
    "/v1/%2e%2e/healthz",
    "/v1/templates/a\\..\\releases",
    // An unencoded character the parser would escape: the path was not built
    // from encoded segments.
    "/v1/templates/web app",
    // Security review: a raw `?`, `#` or `%2F` cuts the path short or, once Gin
    // decodes it, splits a segment — no dot-segment needed. No caller sends a
    // query, so any `?` is refused.
    "/v1/teams/T1#/members",
    "/v1/teams/?/members",
    "/v1/teams/T1?x/members",
    "/v1/releases?limit=50&offset=0",
    "/v1/releases/..%2F..%2Fteams",
    "/v1/releases/x%2flogs",
    "/v1/releases/x%5Clogs",
    "/v1/teams//members",
    "/v1/teams/",
    "/v1/releases?",
  ])("refuses %j", (path) => {
    expect(serverApiUrl(BASE, path)).toBeNull();
  });

  it("refuses rather than throws on an unparseable base", () => {
    expect(serverApiUrl("not a url", "/v1/me")).toBeNull();
  });

  it("compares under a base that has a path of its own", () => {
    expect(serverApiUrl("http://gw.example/api", "/v1/me")).toBe("http://gw.example/api/v1/me");
    expect(serverApiUrl("http://gw.example/api", "/v1/../me")).toBeNull();
  });
});
