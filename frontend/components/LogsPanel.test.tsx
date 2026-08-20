import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { LogsPanel } from "./LogsPanel";

beforeAll(() => {
  // jsdom has no EventSource — install a no-op stub.
  // @ts-expect-error — minimal shape used by the component.
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  };
});

describe("LogsPanel", () => {
  it("starts in 'connecting' state", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByText("연결 중")).toBeInTheDocument();
  });
});
