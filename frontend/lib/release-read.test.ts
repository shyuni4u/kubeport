import { describe, it, expect, vi, beforeEach } from "vitest";

// next/navigation's notFound() and redirect() throw to unwind the render; the
// mocks throw a recognisable value instead so the test can see which one ran.
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({ notFound: () => notFound(), redirect: (to: string) => redirect(to) }));

import { releaseReadFailed } from "./release-read";

beforeEach(() => {
  notFound.mockClear();
  redirect.mockClear();
});

// #183 — the release detail re-reads itself while a rollout settles, so every
// failed read used to be a chance to replace the page with "not found".
describe("releaseReadFailed", () => {
  it("keeps a missing, malformed or someone else's release as not found", () => {
    for (const status of [400, 403, 404]) {
      expect(() => releaseReadFailed(status, "abc")).toThrow("NOT_FOUND");
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends an expired session back to sign in, returning to the same release", () => {
    expect(() => releaseReadFailed(401, "rel-1")).toThrow(
      `REDIRECT /?next=${encodeURIComponent("/releases/rel-1")}`,
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  // A hiccup is not an absence. Thrown, it reaches app/error.tsx, which offers
  // a retry — the page does not claim the release is gone.
  it("does not disguise a server error or a rate limit as not found", () => {
    for (const status of [500, 502, 503, 429]) {
      expect(() => releaseReadFailed(status, "abc")).toThrow(`HTTP ${status}`);
    }
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
