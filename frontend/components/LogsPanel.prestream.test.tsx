import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";

// #134 — the log tab said "연결이 끊겼습니다" for a release that had no pods,
// while the release list one screen over correctly called the same release
// "리소스 없음". The backend was never at fault: it answers
//
//   404  {"title":"no-pods","status":404,"request_id":"..."}
//
// before the SSE handshake. EventSource does not expose that body to
// `onerror`, so every pre-stream refusal — a deleted release, an expired
// session, a demo account reaching outside the demo — collapsed into one
// wrong sentence and a [다시 연결] button that could never succeed.
//
// WHATWG EventSource is what makes the two cases separable: a non-2xx
// response or a wrong MIME type "fails the connection", leaving readyState
// CLOSED with no retry, whereas a mid-stream drop goes back to CONNECTING and
// the browser reconnects on its own.

const CONNECTING = 0;
const CLOSED = 2;

type Stub = {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, ((e: MessageEvent) => void)[]>;
  closed: boolean;
};
const sockets: Stub[] = [];

beforeAll(() => {
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    readyState = CONNECTING;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
    closed = false;
    constructor() {
      sockets.push(this);
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    close() {
      this.closed = true;
    }
  };
});

const fetchMock = vi.fn();

beforeEach(() => {
  sockets.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The server refused before the stream opened: EventSource gives up for good. */
function refuse() {
  act(() => {
    const es = sockets.at(-1)!;
    es.readyState = CLOSED;
    es.onerror?.();
  });
}

/** An open stream dropped mid-flight: the browser will retry by itself. */
function drop() {
  act(() => {
    const es = sockets.at(-1)!;
    es.readyState = CONNECTING;
    es.onerror?.();
  });
}

function problem(title: string, status: number, requestId = "req-1") {
  return new Response(JSON.stringify({ title, status, request_id: requestId }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

describe("LogsPanel pre-stream refusals", () => {
  it("says the release has no running instances instead of blaming the connection", async () => {
    fetchMock.mockResolvedValue(problem("no-pods", 404));
    render(<LogsPanel releaseId="abc" instances={[]} />);

    refuse();

    expect(await screen.findByText(/실행 중인 인스턴스가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/연결이 끊겼습니다/)).toBeNull();
  });

  // Point 3 of the issue: the button worked — it really did re-request the
  // stream — but there are no pods, so it was an invitation to retry forever.
  it("offers no reconnect action for a refusal that retrying cannot fix", async () => {
    fetchMock.mockResolvedValue(problem("no-pods", 404));
    render(<LogsPanel releaseId="abc" instances={[]} />);

    refuse();

    await screen.findByText(/실행 중인 인스턴스가 없습니다/);
    expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  });

  it("reads the refusal from the same URL the stream used", async () => {
    fetchMock.mockResolvedValue(problem("no-pods", 404));
    render(<LogsPanel releaseId="abc" instances={[{ name: "p2" }]} initialInstance="p2" />);

    refuse();

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/releases/abc/logs?instance=p2",
        expect.anything(),
      ),
    );
  });

  it("keeps the request id on screen, the only route to the withheld reason", async () => {
    fetchMock.mockResolvedValue(problem("internal", 500, "req-xyz-9"));
    render(<LogsPanel releaseId="abc" instances={[]} />);

    refuse();

    expect(await screen.findByText(/req-xyz-9/)).toBeInTheDocument();
  });

  it("names the real reason for each kind the endpoint can refuse with", async () => {
    const cases: [string, number, RegExp][] = [
      ["not-found", 404, /릴리스를 찾을 수 없습니다/],
      ["unauthenticated", 401, /로그인이 만료/],
      ["demo-restricted", 403, /데모 계정은/],
      ["rbac-denied", 403, /권한이 없습니다/],
      ["validation-error", 400, /올바르지 않습니다/],
    ];
    for (const [title, status, sentence] of cases) {
      fetchMock.mockResolvedValue(problem(title, status));
      const view = render(<LogsPanel releaseId="abc" instances={[]} />);
      refuse();
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      view.unmount();
    }
  });

  // k8s-error and internal are the two that a retry can actually clear: the
  // cluster was unreachable, or kubeport itself stumbled. Those keep the
  // button — withholding it there would be the mirror of the bug.
  it("still offers a reconnect for a refusal that may clear on its own", async () => {
    fetchMock.mockResolvedValue(problem("k8s-error", 502));
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    refuse();

    expect(await screen.findByText(/클러스터에서 로그를 가져오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 연결" })).toBeInTheDocument();
  });

  // The ErrorKind enum is a machine vocabulary. A kind we have no sentence for
  // must not be printed at the user, and it must not silently become "no pods".
  it("falls back for a kind it has no sentence for", async () => {
    fetchMock.mockResolvedValue(problem("some-future-kind", 418));
    render(<LogsPanel releaseId="abc" instances={[]} />);

    refuse();

    expect(await screen.findByText(/로그 스트림에 문제가 생겼습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/some-future-kind/)).toBeNull();
  });

  // A drop after the stream opened is the case the old copy was written for,
  // and the browser retries it by itself. Probing there would fire a request
  // per drop for nothing.
  it("does not probe when the stream merely dropped mid-flight", async () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    drop();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/연결이 끊겼습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 연결" })).toBeInTheDocument();
  });

  // Between the refusal and the probe the pod may have started. Then there is
  // no Problem to read, and the honest answer is the retryable one — but the
  // probe must not hold that second stream open.
  it("treats a probe that succeeds as retryable and does not hold the stream open", async () => {
    const body = new Response("", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const cancel = vi.spyOn(body.body!, "cancel");
    fetchMock.mockResolvedValue(body);
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    refuse();

    expect(await screen.findByRole("button", { name: "다시 연결" })).toBeInTheDocument();
    expect(cancel).toHaveBeenCalled();
  });

  // Offline, or the BFF answering HTML. We cannot say why, but readyState was
  // CLOSED, so the browser will not retry and the button is the only way back.
  it("falls back to the retryable state when the probe itself fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    refuse();

    expect(await screen.findByRole("button", { name: "다시 연결" })).toBeInTheDocument();
  });

  it("closes the refused stream instead of leaving it around", async () => {
    fetchMock.mockResolvedValue(problem("no-pods", 404));
    render(<LogsPanel releaseId="abc" instances={[]} />);

    refuse();

    await screen.findByText(/실행 중인 인스턴스가 없습니다/);
    expect(sockets.at(-1)!.closed).toBe(true);
  });
});
