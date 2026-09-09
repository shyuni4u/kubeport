import { describe, it, expect, beforeAll } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";

const opened: string[] = [];
type Stub = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  listeners: Record<string, ((e: MessageEvent) => void)[]>;
};
const sockets: Stub[] = [];

beforeAll(() => {
  // jsdom has no EventSource — install a stub that records the URL and keeps
  // the listeners so a test can push a line down the stream.
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
    constructor(url: string) {
      opened.push(url);
      sockets.push(this);
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    close() {}
  };
});

/** Drive the newest stream into the disconnected state. */
function drop() {
  act(() => {
    sockets.at(-1)!.onerror?.();
  });
}

/** Push one log line down the newest stream. */
function emit(text: string) {
  act(() => {
    for (const fn of sockets.at(-1)!.listeners.log ?? []) {
      fn({ data: JSON.stringify({ time: Date.now(), pod: "p1", text }) } as MessageEvent);
    }
  });
}

describe("LogsPanel", () => {
  it("starts in 'connecting' state", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByText("연결 중")).toBeInTheDocument();
  });

  it("streams all instances by default", () => {
    opened.length = 0;
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(opened.at(-1)).toBe("/api/v1/releases/abc/logs?instance=all");
  });

  it("pre-selects initialInstance and streams only that instance", () => {
    opened.length = 0;
    render(
      <LogsPanel
        releaseId="abc"
        instances={[{ name: "p1" }, { name: "p2" }]}
        initialInstance="p2"
      />,
    );
    expect(opened.at(-1)).toBe("/api/v1/releases/abc/logs?instance=p2");
  });
});

// #46 — a dropped stream said "Disconnected" and told the reader to reload the
// page. Reloading a release detail page to get logs back is a heavy, lossy
// answer to a transient SSE drop, and nothing on screen offered a lighter one.
describe("LogsPanel reconnect", () => {
  it("offers no reconnect action while the stream is healthy", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.queryByRole("button", { name: "다시 연결" })).toBeNull();
  });

  it("opens a fresh stream when the reader reconnects after a drop", async () => {
    const user = userEvent.setup();
    opened.length = 0;
    sockets.length = 0;
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(opened).toHaveLength(1);

    drop();
    await user.click(screen.getByRole("button", { name: "다시 연결" }));

    expect(opened).toHaveLength(2);
    expect(opened.at(-1)).toBe("/api/v1/releases/abc/logs?instance=all");
    // Back to "connecting", not stuck on the stale "disconnected" dot.
    expect(screen.getByText("연결 중")).toBeInTheDocument();
  });

  // The lines immediately before a drop are usually the ones being read, so a
  // reconnect reopens the stream in place instead of remounting the buffer away.
  it("keeps the lines received before the drop", async () => {
    const user = userEvent.setup();
    sockets.length = 0;
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);

    emit("last line before the drop");
    drop();
    await user.click(screen.getByRole("button", { name: "다시 연결" }));

    expect(screen.getByText(/last line before the drop/)).toBeInTheDocument();
  });

  it("stops telling the reader to reload the page", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    drop();
    expect(screen.queryByText(/새로고침/)).toBeNull();
  });
});

// #46 — the instance filter rendered the raw value "all" instead of its label,
// so the default state of the control read as a magic string.
describe("LogsPanel instance filter", () => {
  it("shows the translated label for the default selection", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("전체 인스턴스");
  });

  it("shows the pod name when one instance is pre-selected", () => {
    render(
      <LogsPanel
        releaseId="abc"
        instances={[{ name: "p1" }, { name: "p2" }]}
        initialInstance="p2"
      />,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("p2");
  });
});
