import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/tests/intl-test-utils";
import { EditorLayout, MIN_PANEL_PERCENT, WIDE_LAYOUT_MIN_PX } from "./EditorLayout";

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

/** jsdom has no layout, so the breakpoint has to be stated outright. */
function setViewport(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => setViewport(true));

const panels = {
  tree: <div>T</div>,
  inspector: <div>I</div>,
  preview: <div>P</div>,
};

describe("EditorLayout on a wide viewport", () => {
  it("mounts all three panels side by side", () => {
    setViewport(true);
    const { container } = renderWithIntl(<EditorLayout {...panels} />);
    expect(container.textContent).toContain("T");
    expect(container.textContent).toContain("I");
    expect(container.textContent).toContain("P");
  });

  // #45: the three panels were 25/35/40% with percentage minimums, so a 390px
  // viewport gave 80/112/128px columns — "apiVers…" truncated in the tree, and
  // the group itself overflowing horizontally. Spec §3.6 puts the floor at
  // 220px, which only a percentage tied to the breakpoint can honour.
  it("cannot be dragged below the 220px floor at its narrowest", () => {
    expect((MIN_PANEL_PERCENT / 100) * WIDE_LAYOUT_MIN_PX).toBeGreaterThanOrEqual(220);
  });

  it("leaves room for three panels at once", () => {
    expect(MIN_PANEL_PERCENT * 3).toBeLessThanOrEqual(100);
  });
});

describe("EditorLayout on a narrow viewport", () => {
  // Below the threshold there is no width to divide, so the panels become tabs:
  // one at a time, full width, instead of three unusable columns.
  it("shows one panel at a time behind tabs", () => {
    setViewport(false);
    renderWithIntl(<EditorLayout {...panels} />);

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByText("T")).toBeInTheDocument();
    expect(screen.queryByText("I")).toBeNull();
    expect(screen.queryByText("P")).toBeNull();
  });

  it("switches to the panel the reader picks", async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderWithIntl(<EditorLayout {...panels} />);

    await user.click(screen.getAllByRole("tab")[2]);
    expect(screen.getByText("P")).toBeInTheDocument();
    expect(screen.queryByText("T")).toBeNull();
  });

  // A `hidden lg:block` pair would satisfy the assertions above while mounting
  // both layouts, and the preview panel holds a Monaco editor.
  it("does not mount the resizable group as well", () => {
    setViewport(false);
    const { container } = renderWithIntl(<EditorLayout {...panels} />);
    expect(container.querySelectorAll("[data-panel-group]")).toHaveLength(0);
  });
});
