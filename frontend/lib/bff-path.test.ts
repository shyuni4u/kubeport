import { describe, expect, it } from "vitest";

import { upstreamUrl } from "./bff-path";

const BASE = "http://kubeport-backend:8080";

describe("upstreamUrl", () => {
  it("joins the segments the router handed it", () => {
    expect(upstreamUrl(BASE, ["templates", "web-app", "versions", "2"], "")).toBe(
      `${BASE}/v1/templates/web-app/versions/2`,
    );
  });

  it("keeps the query string", () => {
    expect(upstreamUrl(BASE, ["releases"], "?limit=50&offset=0")).toBe(
      `${BASE}/v1/releases?limit=50&offset=0`,
    );
  });

  // The OpenAPI proxy route is a wildcard, so a group/version arrives as two
  // separate segments and must survive.
  it("passes a group/version through as separate segments", () => {
    expect(upstreamUrl(BASE, ["clusters", "oci-a1", "openapi", "apps", "v1"], "")).toBe(
      `${BASE}/v1/clusters/oci-a1/openapi/apps/v1`,
    );
  });

  // Next hands the route decoded segments, so a raw client sending %2e%2e puts
  // an actual ".." in the array and fetch()'s URL parser then collapses it out
  // of the /v1 prefix. Same class as the backend bug in #11.
  it.each([
    [["..", "..", "healthz"]],
    [["templates", "..", "..", "healthz"]],
    [["."]],
    [[""]],
    [["templates", ""]],
    [["a/b"]],
    [["a\\b"]],
  ])("rejects %j", (path) => {
    expect(upstreamUrl(BASE, path as string[], "")).toBeNull();
  });

  // This is why the prefix assertion earns its place: a percent-encoded
  // dot-segment survives the character check (the segment is literally
  // "%2e%2e", not ".."), and the URL parser then decodes AND collapses it —
  // `/v1/%2e%2e` normalises to `/`. A client that double-encodes gets exactly
  // this after Next's own decode.
  it("rejects a percent-encoded dot-segment that the character check misses", () => {
    expect(new URL(`${BASE}/v1/%2e%2e`).toString()).toBe(`${BASE}/`);
    expect(upstreamUrl(BASE, ["%2e%2e"], "")).toBeNull();
    expect(upstreamUrl(BASE, ["templates", "%2e%2e", "%2e%2e", "healthz"], "")).toBeNull();
  });

  it("returns null for an unparseable base instead of throwing", () => {
    expect(upstreamUrl("not a url", ["templates"], "")).toBeNull();
  });
});
