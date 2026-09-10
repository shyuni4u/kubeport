import { describe, it, expect, beforeAll } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";

// A stub EventSource that hands the test the listeners the component
// registered, so a server-sent `error` frame can be delivered on demand.
//
// `closed` is recorded because that is the whole subject of #157: the browser
// keeps reconnecting until someone calls close(), and no assertion about what
// the pane *says* can tell a stopped stream from one still retrying every 3s.
type Listener = (e: MessageEvent) => void;
const listeners = new Map<string, Listener>();
type Stub = { closed: boolean; onerror: ((e?: Event) => void) | null };
const sockets: Stub[] = [];
/** The stream the component is currently on. */
const socket = () => sockets.at(-1)!;

beforeAll(() => {
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: ((e?: Event) => void) | null = null;
    closed = false;
    constructor() {
      listeners.clear();
      sockets.push(this);
    }
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, fn);
    }
    close() {
      this.closed = true;
    }
  };
});

// A server-sent `event: error` frame, dispatched the way a browser dispatches
// it: an "error"-typed MessageEvent reaches BOTH addEventListener("error") and
// onerror. Getting this wrong in the stub is what hid the regression codex
// found — the component looked like it only saw the frame in one place.
function emitError(payload: unknown) {
  const fn = listeners.get("error");
  if (!fn) throw new Error("component registered no 'error' listener");
  const e = { data: JSON.stringify(payload) } as MessageEvent;
  act(() => {
    fn(e);
    socket().onerror?.(e);
  });
}

// The connection-level "error" event, which is what the browser fires when the
// stream actually ends. A plain Event: no `data`, and that absence is the only
// thing separating it from the frame above.
function dropConnection() {
  act(() => {
    socket().onerror?.({} as Event);
  });
}

// The backend used to put client-go's text straight into this frame, and the
// pane rendered it verbatim: the apiserver's address, the namespace and the
// pod name, shown to whoever had the release open — demo visitors included,
// since the demo password is on the landing page (#108). The frame is a
// Problem now (#82) and only its `title` and `request_id` are rendered.
describe("LogsPanel error frames", () => {
  it("renders our own sentence for a known kind, not the server's detail", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({
      type: "https://kubeport.io/errors/k8s-error",
      title: "k8s-error",
      status: 502,
      detail: 'dial tcp 10.43.0.1:6443: connect: connection refused',
      request_id: "req-123",
    });

    expect(screen.getByText(/클러스터에서 로그를 가져오지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/10\.43\.0\.1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/connection refused/)).not.toBeInTheDocument();
  });

  it("shows the request id, which is the only route to the real reason", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "k8s-error", status: 502, request_id: "req-abc-123" });

    expect(screen.getByText(/req-abc-123/)).toBeInTheDocument();
  });

  // A kind we have no sentence for must not print the raw kind at the user;
  // the ErrorKind enum is a machine vocabulary, not UI copy.
  it("falls back for an unrecognised kind", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "some-future-kind", status: 502, request_id: "req-9" });

    expect(screen.getByText(/로그 스트림에 문제가 생겼습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/some-future-kind/)).not.toBeInTheDocument();
  });

  // A frame that is not JSON is a connection-level event; onerror handles it.
  it("ignores a malformed frame instead of rendering it", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    const fn = listeners.get("error");
    act(() => {
      fn?.({ data: "not json" } as MessageEvent);
    });

    expect(screen.queryByText(/not json/)).not.toBeInTheDocument();
  });
});

// #82 made the backend close the stream after an error frame so the client
// would know it had ended. The client never learned: WHATWG gives EventSource
// no way to tell a clean close from a dropped connection, so both land in
// onerror with readyState back at CONNECTING and the browser retries on its
// own timer. Live, one open tab re-hit the apiserver every 3 seconds with no
// backoff and no cap — 18 requests in 53 seconds, each with a fresh request
// id — while the pane said "Disconnected" and offered a Reconnect button that
// was already, invisibly, being pressed (#157).
describe("LogsPanel in-stream termination", () => {
  // The frame is not the end. With ?instance=all the handler follows every pod
  // at once, returns true after writing an error frame, and keeps going until
  // all of them stop — openapi.yaml says so in as many words ("An error frame
  // does not by itself mean the stream is over"). Closing on the frame would
  // cut off every healthy pod because one was unreadable, which is worse than
  // the retry loop this change is here to remove.
  it("keeps a multiplexed stream open when only one pod fails", () => {
    render(
      <LogsPanel releaseId="abc" instances={[{ name: "p1" }, { name: "p2" }]} />,
    );

    emitError({ title: "k8s-error", status: 502, request_id: "req-partial" });

    expect(socket().closed).toBe(false);
    // Still live, so a line from the healthy pod must still land.
    act(() => {
      listeners.get("log")?.({
        data: JSON.stringify({ time: Date.now(), pod: "p2", text: "still here" }),
      } as MessageEvent);
    });
    expect(screen.getByText(/still here/)).toBeInTheDocument();
  });

  it("stops the browser's retry loop after an error frame", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "k8s-error", status: 502, request_id: "req-1" });
    dropConnection();

    // Nothing else can stop the retries: this exact call is the fix.
    expect(socket().closed).toBe(true);
  });

  it("keeps retrying a drop that carried no error frame", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    dropConnection();

    // A bare drop is the case EventSource's own retry is *for* — a proxy
    // timeout, a laptop lid. Closing here would turn a self-healing blip into
    // a manual button press.
    expect(socket().closed).toBe(false);
    expect(screen.getByText("끊김")).toBeInTheDocument();
  });

  it("offers a retry for a transport failure", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "k8s-error", status: 502, request_id: "req-2" });
    dropConnection();

    expect(screen.getByRole("button", { name: "다시 연결" })).toBeInTheDocument();
  });

  // The half of #134 that still holds: a verdict gets no button. These two
  // kinds are the cluster refusing this user's token, and #157's live case —
  // an apiserver that had stopped trusting Dex — was exactly this.
  it.each(["cluster-auth-denied", "rbac-denied"])(
    "withholds the retry for %s, which a retry cannot clear",
    (title) => {
      render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

      emitError({ title, status: 502, request_id: "req-3" });
      dropConnection();

      expect(socket().closed).toBe(true);
      expect(screen.queryByRole("button", { name: "다시 연결" })).not.toBeInTheDocument();
    },
  );

  // The error frame already put the reason on screen. Saying it again in the
  // footer reads as two separate failures.
  it("does not repeat the reason it already printed", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "k8s-error", status: 502, request_id: "req-4" });
    dropConnection();

    expect(screen.getAllByText(/클러스터에서 로그를 가져오지 못했습니다/)).toHaveLength(1);
  });

  // Closing the socket is only half the deal. Having taken the browser's
  // automatic retry away, the button that replaces it has to actually open a
  // stream — otherwise the fix trades a loop nobody asked for for a dead end.
  it("opens a fresh stream when the reader presses Reconnect", async () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emitError({ title: "k8s-error", status: 502, request_id: "req-5" });
    dropConnection();
    const dead = socket();

    await userEvent.click(screen.getByRole("button", { name: "다시 연결" }));

    expect(socket()).not.toBe(dead);
    expect(socket().closed).toBe(false);
    expect(screen.getByText("연결 중")).toBeInTheDocument();
  });
});
