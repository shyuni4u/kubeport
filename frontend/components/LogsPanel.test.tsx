import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { LogsPanel } from "./LogsPanel";

const opened: string[] = [];

beforeAll(() => {
  // jsdom has no EventSource — install a stub that records the URL.
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      opened.push(url);
    }
    addEventListener() {}
    close() {}
  };
});

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
