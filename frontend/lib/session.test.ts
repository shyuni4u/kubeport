import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

// #165: logout must actually remove the __Host- session cookie. The browser
// drops a __Host- Set-Cookie without Secure, and Next's cookies().delete(name)
// sends none — so this asserts the header Next really emits, not the arguments
// of a mocked delete.

const SID = "6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f";

let headers = new Headers();
let responseCookies = new ResponseCookies(headers);
let cookieValue: string | undefined = SID;
const query = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "__Host-kbp_sid" && cookieValue !== undefined ? { name, value: cookieValue } : undefined,
    delete: (...args: Parameters<ResponseCookies["delete"]>) => responseCookies.delete(...args),
  }),
}));
vi.mock("./db", () => ({ pool: { query } }));
vi.mock("./oidc", () => ({ getConfig: vi.fn(), client: {}, parseProvider: (p: string) => p }));

// Postgres' answer to a non-UUID compared with a uuid column.
const invalidUuid = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" });

beforeEach(() => {
  headers = new Headers();
  responseCookies = new ResponseCookies(headers);
  cookieValue = SID;
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function load() {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  return import("./session");
}

function expectCookieCleared() {
  const setCookie = headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^__Host-kbp_sid=; /);
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("Expires=Thu, 01 Jan 1970");
  expect(setCookie).not.toMatch(/Domain=/i);
}

describe("destroySession", () => {
  it("expires the __Host- session cookie with Secure and Path=/, and deletes the row", async () => {
    const { destroySession } = await load();

    await destroySession();

    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE id=$1", [SID]);
    expectCookieCleared();
  });

  // #486: a failed row delete used to throw before the cookie was cleared, so
  // the user saw an error and kept a live session.
  it("still expires the cookie when the row delete fails", async () => {
    query.mockRejectedValue(new Error("connection terminated"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { destroySession } = await load();

    await expect(destroySession()).resolves.toBeUndefined();

    expectCookieCleared();
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SID);
    errors.mockRestore();
  });

  // #487: a malformed cookie made the DELETE throw 22P02, so logout could
  // never get the user out of it.
  it("skips the query for a malformed cookie and still expires it", async () => {
    cookieValue = "sid-1";
    query.mockRejectedValue(invalidUuid);
    const { destroySession } = await load();

    await destroySession();

    expect(query).not.toHaveBeenCalled();
    expectCookieCleared();
  });
});

describe("getSession", () => {
  it("treats a malformed cookie as no session without querying", async () => {
    cookieValue = "sid-1";
    query.mockRejectedValue(invalidUuid);
    const { getSession, getSessionById } = await load();

    await expect(getSession()).resolves.toBeNull();
    await expect(getSessionById("not-a-uuid")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("looks up a well-formed cookie", async () => {
    const { getSession } = await load();

    await expect(getSession()).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM sessions WHERE id=$1"), [SID]);
  });
});
