import { describe, it, expect, beforeAll } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";

// A stub EventSource that hands the test the listeners the component
// registered, so a server-sent `error` frame can be delivered on demand.
type Listener = (e: MessageEvent) => void;
const listeners = new Map<string, Listener>();

beforeAll(() => {
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      listeners.clear();
    }
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, fn);
    }
    close() {}
  };
});

function emitError(payload: unknown) {
  const fn = listeners.get("error");
  if (!fn) throw new Error("component registered no 'error' listener");
  act(() => {
    fn({ data: JSON.stringify(payload) } as MessageEvent);
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
