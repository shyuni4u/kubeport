import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

// #165: logout must actually remove the __Host- session cookie. The browser
// drops a __Host- Set-Cookie without Secure, and Next's cookies().delete(name)
// sends none — so this asserts the header Next really emits, not the arguments
// of a mocked delete.

const headers = new Headers();
const responseCookies = new ResponseCookies(headers);
const query = vi.fn(async () => ({ rows: [] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-kbp_sid" ? { name, value: "sid-1" } : undefined),
    delete: (...args: Parameters<ResponseCookies["delete"]>) => responseCookies.delete(...args),
  }),
}));
vi.mock("./db", () => ({ pool: { query } }));
vi.mock("./oidc", () => ({ getConfig: vi.fn(), client: {}, parseProvider: (p: string) => p }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("destroySession", () => {
  it("expires the __Host- session cookie with Secure and Path=/, and deletes the row", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { destroySession } = await import("./session");

    await destroySession();

    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE id=$1", ["sid-1"]);
    const setCookie = headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-kbp_sid=; /);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Expires=Thu, 01 Jan 1970");
    expect(setCookie).not.toMatch(/Domain=/i);
  });
});
