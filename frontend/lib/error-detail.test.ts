import { describe, expect, it } from "vitest";
import {
  defaultErrorDetailLevel,
  errorDetailCookie,
  parseErrorDetailLevel,
  parseProblemBody,
  problemParts,
  resolveErrorDetailLevel,
} from "./error-detail";

describe("parseErrorDetailLevel", () => {
  it("accepts the three levels and nothing else", () => {
    expect(parseErrorDetailLevel("friendly")).toBe("friendly");
    expect(parseErrorDetailLevel("detailed")).toBe("detailed");
    expect(parseErrorDetailLevel("raw")).toBe("raw");
    for (const bad of ["", "RAW", "verbose", undefined, null]) {
      expect(parseErrorDetailLevel(bad)).toBeUndefined();
    }
  });
});

describe("defaultErrorDetailLevel", () => {
  it("starts an admin at raw and a user at friendly", () => {
    expect(defaultErrorDetailLevel({ role: "admin", demo: false })).toBe("raw");
    expect(defaultErrorDetailLevel({ role: "user", demo: false })).toBe("friendly");
  });

  it("takes the install's defaults, and ignores values that are not a level", () => {
    expect(defaultErrorDetailLevel({ role: "admin", demo: false, adminDefault: "detailed" })).toBe("detailed");
    expect(defaultErrorDetailLevel({ role: "user", demo: false, userDefault: "raw" })).toBe("raw");
    expect(defaultErrorDetailLevel({ role: "user", demo: false, userDefault: "off" })).toBe("friendly");
  });

  // The demo is public and its admin screens are shown to visitors.
  it("starts a demo admin at detailed whatever the install says", () => {
    expect(defaultErrorDetailLevel({ role: "admin", demo: true, adminDefault: "raw" })).toBe("detailed");
    expect(defaultErrorDetailLevel({ role: "user", demo: true })).toBe("friendly");
  });
});

describe("resolveErrorDetailLevel", () => {
  it("lets a valid cookie win and falls back otherwise", () => {
    expect(resolveErrorDetailLevel("raw", "friendly")).toBe("raw");
    expect(resolveErrorDetailLevel("garbage", "detailed")).toBe("detailed");
    expect(resolveErrorDetailLevel(undefined, "friendly")).toBe("friendly");
  });
});

describe("errorDetailCookie", () => {
  it("is host-only on Path=/ with SameSite=Lax, Secure only on https", () => {
    const plain = errorDetailCookie("raw", false);
    expect(plain).toMatch(/^kbp_error_detail=raw; /);
    expect(plain).toContain("Path=/");
    expect(plain).toContain("SameSite=Lax");
    expect(plain.toLowerCase()).not.toContain("domain=");
    expect(plain.toLowerCase()).not.toContain("httponly");
    expect(plain).not.toContain("Secure");
    expect(errorDetailCookie("raw", true)).toContain("; Secure");
  });
});

describe("parseProblemBody", () => {
  it("reads the envelope and keeps extension members apart", () => {
    const p = parseProblemBody(
      JSON.stringify({
        type: "https://kubeport.io/errors/resource-conflict",
        title: "resource-conflict",
        status: 409,
        detail: "held",
        request_id: "req-1",
        conflicts: [{ kind: "Service", name: "web" }],
      }),
    );
    expect(p).toEqual({
      title: "resource-conflict",
      detail: "held",
      requestId: "req-1",
      extensions: { conflicts: [{ kind: "Service", name: "web" }] },
    });
  });

  it("is null for what is not a Problem", () => {
    for (const body of ["", "not json", "[]", "null", JSON.stringify({ detail: "no title" })]) {
      expect(parseProblemBody(body)).toBeNull();
    }
  });
});

describe("problemParts", () => {
  const forbidden = parseProblemBody(
    JSON.stringify({ title: "k8s-error", status: 502, detail: 'deployments.apps is forbidden: User "u" cannot create', request_id: "r" }),
  );
  const internal = parseProblemBody(JSON.stringify({ title: "internal", status: 500, detail: "CreateRelease failed", request_id: "r" }));

  it("friendly unfolds nothing", () => {
    expect(problemParts("friendly", 502, forbidden)).toEqual({ kind: false, open: false });
  });

  it("detailed shows the kind and a cluster's message, folded", () => {
    expect(problemParts("detailed", 502, forbidden)).toEqual({
      kind: true,
      detail: 'deployments.apps is forbidden: User "u" cannot create',
      extensions: undefined,
      open: false,
    });
  });

  // A 500 names the failed operation only; the cause stays in the server log (#49).
  it("detailed leaves a 500's operation sentence to raw", () => {
    expect(problemParts("detailed", 500, internal).detail).toBeUndefined();
    expect(problemParts("raw", 500, internal)).toMatchObject({ detail: "CreateRelease failed", open: true });
  });

  it("shows nothing for a body that is not a Problem", () => {
    expect(problemParts("raw", 502, null)).toEqual({ kind: false, open: false });
  });
});
