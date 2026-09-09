import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ORIGINAL_BASE = process.env.GO_API_BASE_URL;

afterEach(() => {
  process.env.GO_API_BASE_URL = ORIGINAL_BASE;
  vi.unstubAllGlobals();
});

function stubFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("GET /api/healthz", () => {
  it("passes the backend body through verbatim", async () => {
    process.env.GO_API_BASE_URL = "http://api.test";
    const upstream = { status: "ok", catalog: { available: true, templates: 3 } };
    stubFetch(
      (async () =>
        new Response(JSON.stringify(upstream), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

    const res = await GET();

    expect(res.status).toBe(200);
    // Verbatim matters: the cron reads `catalog.templates`, and re-shaping the
    // body here would leave two schemas to keep in step.
    await expect(res.json()).resolves.toEqual(upstream);
  });

  it("asks the backend for the verbose form", async () => {
    process.env.GO_API_BASE_URL = "http://api.test";
    const spy = vi.fn(
      async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    stubFetch(spy as unknown as typeof fetch);

    await GET();

    expect(spy).toHaveBeenCalledWith(
      "http://api.test/healthz?verbose=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reports degraded, not a crash, when the backend is unreachable", async () => {
    process.env.GO_API_BASE_URL = "http://api.test";
    stubFetch((async () => {
      throw new Error("ECONNREFUSED 10.43.0.7:8080");
    }) as unknown as typeof fetch);

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    // The endpoint is unauthenticated; the reason would carry the in-cluster
    // Service address.
    expect(JSON.stringify(body)).not.toContain("10.43.0.7");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("reports degraded when the backend answers non-2xx", async () => {
    process.env.GO_API_BASE_URL = "http://api.test";
    stubFetch(
      (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    );

    const res = await GET();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ status: "degraded" });
  });

  it("reports degraded when the backend URL is not configured", async () => {
    delete process.env.GO_API_BASE_URL;

    const res = await GET();

    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("degraded");
  });
});
