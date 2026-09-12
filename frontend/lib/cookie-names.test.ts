import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

// #165: the names are computed at module load from NODE_ENV, so each case
// loads a fresh copy of the module under the environment it is about.
async function load(env: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env);
  return import("./cookie-names");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth cookie names", () => {
  it("carries __Host- in production, where the cookies are Secure", async () => {
    const m = await load("production");
    expect(m.SESSION_COOKIE).toBe("__Host-kbp_sid");
    expect(m.OIDC_STATE_COOKIE).toBe("__Host-kbp_oidc_state");
    // __Host- is refused by the browser unless all three hold.
    expect(m.AUTH_COOKIE_ATTRS).toMatchObject({ secure: true, path: "/" });
    expect(m.AUTH_COOKIE_ATTRS).not.toHaveProperty("domain");
  });

  it("stays unprefixed over the plain http of dev and e2e, where Secure is off", async () => {
    const m = await load("development");
    expect(m.SESSION_COOKIE).toBe("kbp_sid");
    expect(m.OIDC_STATE_COOKIE).toBe("kbp_oidc_state");
    expect(m.AUTH_COOKIE_ATTRS.secure).toBe(false);
  });
});

describe("clearAuthCookie", () => {
  // A bare cookies().delete(name) sends no Secure, and a browser drops a
  // __Host- Set-Cookie without it — the session would survive logout.
  it("deletes with the attributes the cookie was set with", async () => {
    const m = await load("production");
    const store = { delete: vi.fn() };
    m.clearAuthCookie(store, m.SESSION_COOKIE);
    expect(store.delete).toHaveBeenCalledWith({
      name: "__Host-kbp_sid",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  // The call arguments above are not the contract; the header is. Serialize
  // through Next's own ResponseCookies and check what the browser would get.
  it("emits a Set-Cookie a browser accepts for a __Host- cookie", async () => {
    const m = await load("production");
    const headers = new Headers();
    m.clearAuthCookie(new ResponseCookies(headers), m.SESSION_COOKIE);
    const setCookie = headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-kbp_sid=; /);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("is needed: a bare delete(name) emits no Secure, which a browser drops for __Host-", () => {
    const headers = new Headers();
    new ResponseCookies(headers).delete("__Host-kbp_sid");
    expect(headers.get("set-cookie") ?? "").not.toContain("Secure");
  });
});
