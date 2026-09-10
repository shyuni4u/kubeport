import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The proxy only asks the session layer for a token; both calls hit postgres.
const getSession = vi.fn();
const getValidToken = vi.fn();
vi.mock("@/lib/session", () => ({
  getSession: () => getSession(),
  getValidToken: (s: unknown) => getValidToken(s),
}));

import { GET } from "./route";

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
