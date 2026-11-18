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
    set: (...args: Parameters<ResponseCookies["set"]>) => responseCookies.set(...args),
    delete: (...args: Parameters<ResponseCookies["delete"]>) => responseCookies.delete(...args),
  }),
}));
vi.mock("./db", () => ({ pool: { query } }));
const refreshTokenGrant = vi.fn();
class ResponseBodyError extends Error {
  constructor(public error: string) { super(error); }
}
vi.mock("./oidc", () => ({
  getConfig: vi.fn(), client: { refreshTokenGrant: (...args: unknown[]) => refreshTokenGrant(...args), get ResponseBodyError() { return ResponseBodyError; } }, parseProvider: (p: string) => p,
}));

// Postgres' answer to a non-UUID compared with a uuid column.
const invalidUuid = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" });

beforeEach(() => {
  headers = new Headers();
  responseCookies = new ResponseCookies(headers);
  cookieValue = SID;
  refreshTokenGrant.mockReset();
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

describe("session token lifetime", () => {
  const session = () => ({ id: SID, userId: "u", idToken: "old", refreshToken: "refresh", idTokenExp: new Date(Date.now() - 1000), provider: "primary" as const });
  it("caps unrefreshable sessions and cookies at token expiry", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32).toString("base64"));
    const { createSession } = await load();
    const exp = new Date(Date.now() + 3600_000);
    await createSession("u", "token", undefined, exp);
    expect((query.mock.calls[0][1] as unknown[])[5]).toEqual(exp);
    expect(headers.get("set-cookie")).toContain(`Expires=${exp.toUTCString()}`);
  });
  it("uses an unrefreshable token during its final minute", async () => {
    const { getValidToken } = await load();
    await expect(getValidToken({ ...session(), refreshToken: undefined, idTokenExp: new Date(Date.now() + 30_000) })).resolves.toBe("old");
    await expect(getValidToken({ ...session(), refreshToken: undefined })).resolves.toBeNull();
  });
  it.each(["invalid_grant", "invalid_client"])("revokes a definitively rejected %s grant", async code => {
    refreshTokenGrant.mockRejectedValue(new ResponseBodyError(code));
    const { getValidToken } = await load();
    await expect(getValidToken(session())).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE id=$1", [SID]);
  });
  it.each([new Error("network failure"), new ResponseBodyError("server_error")])("retains sessions after transient refresh failures: %s", async error => {
    refreshTokenGrant.mockRejectedValue(error);
    const { getValidToken } = await load();
    await expect(getValidToken(session())).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not delete the session when persisting refreshed tokens fails", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY_B64", Buffer.alloc(32).toString("base64"));
    refreshTokenGrant.mockResolvedValue({ id_token: "new", expiresIn: () => 3600 });
    query.mockRejectedValue(new Error("database down"));
    const { getValidToken } = await load();
    await expect(getValidToken(session())).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("UPDATE sessions");
  });
});

it("lets page authentication distinguish transient refresh failures", async () => {
  refreshTokenGrant.mockRejectedValue(new Error("network failure"));
  const { getValidToken } = await load();
  await expect(getValidToken({ id: SID, userId: "u", idToken: "old", refreshToken: "r", idTokenExp: new Date(0), provider: "primary" }, { throwOnTransientFailure: true })).rejects.toThrow("temporarily unavailable");
  expect(query).not.toHaveBeenCalled();
});
