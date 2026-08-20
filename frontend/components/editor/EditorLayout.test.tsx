import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { EditorLayout } from "./EditorLayout";

// jsdom does not implement ResizeObserver, but react-resizable-panels
// reads it via `ownerDocument.defaultView.ResizeObserver` on mount.
// Provide a minimal stub so the component can mount.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }
});

describe("EditorLayout", () => {
  it("mounts all three panels", () => {
    const { container } = render(
      <EditorLayout
        tree={<div>T</div>}
        inspector={<div>I</div>}
        preview={<div>P</div>}
      />,
    );
    expect(container.textContent).toContain("T");
    expect(container.textContent).toContain("I");
    expect(container.textContent).toContain("P");
  });
});
