import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn(async () => ({ id: "session" }));
const getValidToken = vi.fn(async () => "id-token");
vi.mock("./session", () => ({
  getSession: () => getSession(),
  getValidToken: () => getValidToken(),
}));

import { apiFetch } from "./api-server";

const BASE = "http://kubeport-backend:8080";
const ID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("GO_API_BASE_URL", BASE);
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  getSession.mockClear();
  getValidToken.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("requests a /v1 path as given, with the caller's token", async () => {
    const res = await apiFetch("/v1/templates/web%20app/versions/2", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/v1/templates/web%20app/versions/2`, {
      cache: "no-store",
      method: "DELETE",
      headers: { Authorization: "Bearer id-token" },
    });
  });

  // #374 — the last line for every server-side call, whatever built its path.
  // The pages check their own params first; this catches a path a later page
  // builds without doing so: a dot-segment, or a raw `?`, `#` or `%2F` that
  // cuts the path short or splits a segment once Gin decodes it.
  it.each([
    `/v1/templates/../releases/${ID}`,
    `/v1/teams/../releases/${ID}/members`,
    `/v1/releases/%2e%2e/templates/web-app`,
    "/v1/teams/?/members",
    `/v1/releases/${ID}%2Flogs`,
    "/healthz",
  ])("refuses %j without reading the session or calling the API", async (path) => {
    const res = await apiFetch(path, { method: "DELETE" });

    expect(res.status).toBe(404);
    expect((await res.json()).title).toBe("not-found");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("fails loudly when the API base is not configured", async () => {
    vi.stubEnv("GO_API_BASE_URL", "");
    await expect(apiFetch("/v1/me")).rejects.toThrow("GO_API_BASE_URL is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
