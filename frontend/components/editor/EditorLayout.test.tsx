import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/tests/intl-test-utils";
import {
  EditorLayout,
  MIN_PANEL_PERCENT,
  SHELL_CHROME_PX,
  WIDE_LAYOUT_MIN_PX,
} from "./EditorLayout";

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
    expect(container.querySelectorAll("[data-panel]")).toHaveLength(3);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  // #45: the three panels were 25/35/40% with percentage minimums, so a 390px
  // viewport gave 80/112/128px columns — "apiVers…" truncated in the tree, and
  // the group itself overflowing horizontally. Spec §3.6 puts the floor at
  // 220px.
  //
  // The subtraction is the whole point. react-resizable-panels sizes panels
  // against the *group*, and AppShell's sidebar and padding mean the group is
  // never the viewport. Computing the percentage against the viewport is how
  // the first attempt at this landed on 22%, which is 162px of the real 736px
  // group — under the floor it was written to enforce.
  it("cannot be dragged below the 220px floor at its narrowest", () => {
    expect(
      (MIN_PANEL_PERCENT / 100) * (WIDE_LAYOUT_MIN_PX - SHELL_CHROME_PX),
    ).toBeGreaterThanOrEqual(220);
  });

  it("leaves room for three panels at once", () => {
    expect(MIN_PANEL_PERCENT * 3).toBeLessThanOrEqual(100);
  });

  // The two assertions above are arithmetic on exported constants, so they
  // hold even if nothing passes them to a panel. This one checks the wiring.
  it("gives every panel that floor", async () => {
    setViewport(true);
    const mod = await import("@/components/ui/resizable");
    const seen: unknown[] = [];
    const spy = vi
      .spyOn(mod, "ResizablePanel")
      .mockImplementation((props: Record<string, unknown>) => {
        seen.push(props.minSize);
        return <div>{props.children as React.ReactNode}</div>;
      });

    renderWithIntl(<EditorLayout {...panels} />);
    expect(seen).toEqual([MIN_PANEL_PERCENT, MIN_PANEL_PERCENT, MIN_PANEL_PERCENT]);
    spy.mockRestore();
  });

  // A default below the floor is the same bug arriving before anyone drags.
  it("starts every panel at or above the floor", async () => {
    setViewport(true);
    const mod = await import("@/components/ui/resizable");
    const seen: number[] = [];
    const spy = vi
      .spyOn(mod, "ResizablePanel")
      .mockImplementation((props: Record<string, unknown>) => {
        seen.push(props.defaultSize as number);
        return <div>{props.children as React.ReactNode}</div>;
      });

    renderWithIntl(<EditorLayout {...panels} />);
    for (const size of seen) expect(size).toBeGreaterThanOrEqual(MIN_PANEL_PERCENT);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(100);
    spy.mockRestore();
  });
});

describe("EditorLayout on a narrow viewport", () => {
  // Below the threshold there is no width to divide, so the panels become tabs:
  // one at a time, full width, instead of three unusable columns.
  /**
   * On screen: rendered, and not inside a panel Base UI has marked `hidden`.
   * `keepMounted` means "in the DOM" no longer implies "visible", so the two
   * have to be told apart.
   */
  const showing = (text: string) => {
    const el = screen.queryByText(text);
    return el !== null && el.closest("[hidden]") === null;
  };

  it("shows one panel at a time behind tabs", () => {
    setViewport(false);
    renderWithIntl(<EditorLayout {...panels} />);

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(showing("T")).toBe(true);
    expect(showing("I")).toBe(false);
    expect(showing("P")).toBe(false);
  });

  it("switches to the panel the reader picks", async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderWithIntl(<EditorLayout {...panels} />);

    await user.click(screen.getAllByRole("tab")[2]);
    expect(showing("P")).toBe(true);
    expect(showing("T")).toBe(false);
  });

  // A `hidden lg:block` pair would satisfy the assertions above while mounting
  // both layouts, and the preview panel holds a Monaco editor.
  //
  // The selector matters: this was first written against `[data-panel-group]`,
  // which react-resizable-panels does not render, so it matched nothing on
  // either branch and could never fail. The wide test above asserts the same
  // selectors find something, which is what keeps this one honest.
  it("does not mount the resizable group as well", () => {
    setViewport(false);
    const { container } = renderWithIntl(<EditorLayout {...panels} />);
    expect(
      container.querySelectorAll('[data-slot="resizable-panel-group"]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll("[data-panel]")).toHaveLength(0);
  });

  // SchemaTree keeps its expanded set in local state, and Base UI unmounts a
  // hidden tab panel by default — so without keepMounted, every trip to the
  // inspector and back collapsed the tree the reader had just opened.
  it("keeps the tree mounted while another tab is showing", async () => {
    setViewport(false);
    const user = userEvent.setup();
    const { container } = renderWithIntl(<EditorLayout {...panels} />);

    await user.click(screen.getAllByRole("tab")[1]);
    expect(screen.getByText("I")).toBeInTheDocument();
    // Present in the DOM, just not the visible panel.
    expect(container.textContent).toContain("T");
  });

  // The preview is the exception: it holds the Monaco instance this layout
  // splits on in the first place, so it stays unmounted until asked for.
  it("still unmounts the preview", async () => {
    setViewport(false);
    const user = userEvent.setup();
    const { container } = renderWithIntl(<EditorLayout {...panels} />);

    expect(container.textContent).not.toContain("P");
    await user.click(screen.getAllByRole("tab")[2]);
    expect(screen.getByText("P")).toBeInTheDocument();
  });

  // Tapping a field in the tree used to look like it did nothing: the
  // inspector it filled in was behind another tab.
  it("follows a tree selection into the inspector", () => {
    setViewport(false);
    const { rerender } = renderWithIntl(
      <EditorLayout {...panels} selection={null} />,
    );
    expect(screen.getByText("T")).toBeVisible();

    rerender(<EditorLayout {...panels} selection="0:spec.replicas" />);
    expect(screen.getByText("I")).toBeVisible();
  });
});
