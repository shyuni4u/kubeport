import { afterEach, describe, expect, it, vi } from "vitest";

import { requestLogout } from "./logout";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(make: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(make));
}

describe("requestLogout", () => {
  it("POSTs without following the redirect, so the route's own answer is read", async () => {
    stubFetch(async () => new Response(null, { status: 303 }));

    expect(await requestLogout()).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", { method: "POST", redirect: "manual" });
  });

  // What a browser actually hands back for that 303 under redirect: "manual".
  it("treats an opaque redirect as the success it is", async () => {
    stubFetch(async () => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      Object.defineProperty(res, "ok", { value: false });
      return res;
    });

    expect(await requestLogout()).toBe(true);
  });

  // A changed domain without PUBLIC_ORIGIN following it refuses every logout
  // with 403 — the session is still alive.
  it("reports a refused logout as a failure", async () => {
    stubFetch(async () => new Response("cross-origin request rejected", { status: 403 }));

    expect(await requestLogout()).toBe(false);
  });

  it("reports a request that never landed as a failure", async () => {
    stubFetch(async () => {
      throw new Error("offline");
    });

    expect(await requestLogout()).toBe(false);
  });
});
