// @vitest-environment node
// The route handler runs on the server. Under the default jsdom environment the
// global AbortController is jsdom's, and Node 24's Request (undici) rejects its
// signal as "not an instance of AbortSignal" — Node 22 happened not to check.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The proxy only asks the session layer for a token; both calls hit postgres.
const getSession = vi.fn();
const getValidToken = vi.fn();
vi.mock("@/lib/session", () => ({
  getSession: () => getSession(),
  getValidToken: (s: unknown) => getValidToken(s),
}));

import { GET, POST } from "./route";

const fetchMock = vi.fn();

beforeEach(() => {
  getSession.mockReset();
  getValidToken.mockReset();
  fetchMock.mockReset();
  getSession.mockResolvedValue({ id: "s1" });
  getValidToken.mockResolvedValue("id-token");
  fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GO_API_BASE_URL", "http://backend:8080");
});

function req(headers?: Record<string, string>) {
  return new NextRequest(
    new URL("https://kubeport.enzo.kr/api/v1/releases/r1/logs?instance=all"),
    { method: "GET", headers },
  );
}

const params = { params: Promise.resolve({ path: ["releases", "r1", "logs"] }) };

/** Headers the proxy handed upstream on the last call. */
function sentHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

// The log stream resumes with SSE's own mechanism: the server puts an `id:` on
// each frame, and on its automatic reconnect the browser sends the last one
// back as `Last-Event-ID`. That reconnect is the one nobody chooses, and it is
// the one that used to replay the whole container log into a pane the browser
// does not clear (#107).
//
// None of that works if the header stops at the BFF. It builds an explicit
// allowlist rather than passing browser headers through, which is the right
// posture — so this one has to be named, and named tightly enough that adding
// it did not open the door to everything else.
describe("BFF proxy — resume header", () => {
  it("forwards Last-Event-ID upstream", async () => {
    await GET(req({ "Last-Event-ID": "2026-09-09T07:36:36.123456789Z" }), params);

    expect(sentHeaders()["Last-Event-ID"]).toBe("2026-09-09T07:36:36.123456789Z");
  });

  // The only reader of this header is the log stream, which is always a GET.
  // The proxy serves every method on every path, so the entry is scoped to
  // match its one consumer rather than the whole surface.
  it("does not forward Last-Event-ID on anything but GET", async () => {
    await POST(
      new NextRequest(new URL("https://kubeport.enzo.kr/api/v1/releases"), {
        method: "POST",
        headers: { "Last-Event-ID": "2026-09-09T07:36:36Z", "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["releases"] }) },
    );

    expect(sentHeaders()).not.toHaveProperty("Last-Event-ID");
  });

  it("sends no resume header when the browser has nothing to resume from", async () => {
    await GET(req(), params);

    expect(sentHeaders()).not.toHaveProperty("Last-Event-ID");
  });

  // The allowlist is the point. A header the browser controls reaching the
  // backend is a decision, not a default, and this asserts the decision stayed
  // narrow — Cookie in particular, since the session lives in one and the
  // backend must only ever see the bearer token the BFF minted.
  it("still forwards nothing else the caller sent", async () => {
    await GET(
      req({
        Cookie: "kbp_sid=stolen",
        "X-Forwarded-For": "10.0.0.1",
        "User-Agent": "curl/8",
        Authorization: "Bearer not-mine",
      }),
      params,
    );

    const sent = sentHeaders();
    expect(sent["Authorization"]).toBe("Bearer id-token");
    for (const header of ["Cookie", "X-Forwarded-For", "User-Agent"]) {
      expect(sent, `${header} must not reach the backend`).not.toHaveProperty(header);
    }
  });
});

// The backend caps bodies at 4 MiB, but the BFF read the whole body into memory
// before forwarding it, so the cap protected everything except the one process
// facing the internet (#128).
describe("BFF proxy — body cap", () => {
  const MiB = 1024 * 1024;

  function post(body: string) {
    return POST(
      new NextRequest(new URL("https://kubeport.enzo.kr/api/v1/templates/preview"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ path: ["templates", "preview"] }) },
    );
  }

  it("answers an oversized body with the backend's 413 and does not forward it", async () => {
    const res = await post("a".repeat(4 * MiB + 1));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      title: "payload-too-large",
      status: 413,
      detail: "request body exceeds 4 MiB",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a body within the cap byte for byte", async () => {
    await post('{"name":"web"}');

    const sent = fetchMock.mock.calls[0][1].body as Uint8Array;
    expect(new TextDecoder().decode(sent)).toBe('{"name":"web"}');
  });

  // A client hanging up mid-upload errors the body stream (ECONNRESET), not
  // fetch. That is the caller leaving, and must not be logged as the API down.
  it("answers 499 when the client goes away while its body is being read", async () => {
    const aborter = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        aborter.abort();
        controller.error(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      new NextRequest(new URL("https://kubeport.enzo.kr/api/v1/templates/preview"), {
        method: "POST",
        body,
        signal: aborter.signal,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]),
      { params: Promise.resolve({ path: ["templates", "preview"] }) },
    );

    expect(res.status).toBe(499);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  // Order matters for the machine-client contract: through the BFF, no session
  // is 401 whatever the size, and nothing of the body is read to find that out.
  it("still answers 401 first to a caller without a session", async () => {
    getValidToken.mockResolvedValue(null);

    const res = await post("a".repeat(4 * MiB + 1));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
