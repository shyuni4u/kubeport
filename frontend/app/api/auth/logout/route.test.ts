import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// getSession talks to postgres; the route only asks it "is there a session".
const getSession = vi.fn();
const destroySession = vi.fn();
vi.mock("@/lib/session", () => ({
  getSession: () => getSession(),
  destroySession: () => destroySession(),
}));

import { GET, POST } from "./route";

function req(method: string, headers?: Record<string, string>) {
  return new NextRequest(new URL("https://kubeport.enzo.kr/api/auth/logout"), {
    method,
    headers,
  });
}

beforeEach(() => {
  getSession.mockReset();
  destroySession.mockReset();
});

// #28: navigating to the logout URL — typed, or from a bookmark — answered 405
// and left the session intact, so it read as "logout does nothing".
describe("GET /api/auth/logout", () => {
  it("no longer answers 405", async () => {
    getSession.mockResolvedValue({ id: "s1" });
    expect((await GET(req("GET"))).status).not.toBe(405);
  });

  it("sends a signed-in visitor to the confirmation screen", async () => {
    getSession.mockResolvedValue({ id: "s1" });
    const res = await GET(req("GET"));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/logout");
  });

  // The point of the confirmation. A GET is something any other site can cause
  // — an <img>, a link, a redirect — so logging out here would hand every page
  // on the web a button that signs this user out. The POST below checks Origin
  // for exactly that reason, and this must not become the way around it.
  it("does not end the session by itself", async () => {
    getSession.mockResolvedValue({ id: "s1" });
    await GET(req("GET"));
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("sends a visitor with no session to landing, not to a confirmation", async () => {
    getSession.mockResolvedValue(null);
    const res = await GET(req("GET"));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(destroySession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/logout", () => {
  it("still ends the session for a same-origin caller", async () => {
    const res = await POST(req("POST", { origin: "https://kubeport.enzo.kr" }));
    expect(destroySession).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
  });

  it("still refuses a cross-origin caller", async () => {
    const res = await POST(req("POST", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("still refuses a caller that sends no Origin at all", async () => {
    const res = await POST(req("POST"));
    expect(res.status).toBe(403);
    expect(destroySession).not.toHaveBeenCalled();
  });
});
