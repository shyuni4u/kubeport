import { describe, expect, it } from "vitest";

import { apiPathSegment, isSafePathSegment, versionSegment } from "./api-path";

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
