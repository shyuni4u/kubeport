import { describe, it, expect } from "vitest";
import { bffProblem } from "./bff-problem";
import { GET } from "@/app/api/v1/route";
import type { NextRequest } from "next/server";

function req(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

describe("bffProblem", () => {
  it("matches the Go API's Problem shape so one parser covers /api/v1", async () => {
    const res = bffProblem("validation-error", 400, "malformed request path", "req-1");

    expect(res.status).toBe(400);
    expect(res.headers.get("X-Request-Id")).toBe("req-1");
    await expect(res.json()).resolves.toEqual({
      type: "https://kubeport.io/errors/validation-error",
      title: "validation-error",
      status: 400,
      detail: "malformed request path",
      request_id: "req-1",
    });
  });
});

// `/api/v1` with no segments does not match the `[...path]` proxy next door,
// so it used to fall through to Next's HTML 404 — the one corner of the API
// that answered in neither the Problem schema nor JSON (#81). Probing the root
// is what a client does while discovering the API, which makes a web page a
// particularly unhelpful answer there.
describe("GET /api/v1", () => {
  it("answers a JSON Problem, not Next's HTML 404", async () => {
    const res = await GET(req());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toBe("not-found");
    expect(body.status).toBe(404);
    expect(body.request_id).toBeTruthy();
  });

  it("keeps the caller's request id so the probe stays traceable", async () => {
    const res = await GET(req({ "x-request-id": "trace-42" }));

    expect(res.headers.get("X-Request-Id")).toBe("trace-42");
    await expect(res.json()).resolves.toMatchObject({ request_id: "trace-42" });
  });
});
