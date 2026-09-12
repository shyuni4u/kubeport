import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { PreviewErrorBoundary } from "./PreviewErrorBoundary";

function Boom({ blow }: { blow: boolean }) {
  if (blow) throw new Error("kaboom");
  return <div>preview</div>;
}

function renderBoundary(blow: boolean) {
  return render(
    <PreviewErrorBoundary fallback={(m) => <div>fallback: {m}</div>}>
      <Boom blow={blow} />
    </PreviewErrorBoundary>,
  );
}

describe("PreviewErrorBoundary", () => {
  // React logs the caught error; the throw is the point of these tests.
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders children when nothing throws", () => {
    renderBoundary(false);
    expect(screen.getByText("preview")).toBeInTheDocument();
  });

  // #164 — the whole point: the editor beside this must survive, so the throw
  // stops here and the reason is shown in place.
  it("shows the fallback with the error message instead of propagating", () => {
    expect(() => renderBoundary(true)).not.toThrow();
    expect(screen.getByText(/fallback: kaboom/)).toBeInTheDocument();
  });

  // The admin's next keystroke is the retry. Without the reset the fallback
  // would outlive the mistake that caused it and read as "the editor broke",
  // which leaves the boundary solving only half of what it is for.
  it("clears the fallback when the children change", () => {
    const { rerender } = renderBoundary(true);
    expect(screen.getByText(/fallback: kaboom/)).toBeInTheDocument();

    rerender(
      <PreviewErrorBoundary fallback={(m) => <div>fallback: {m}</div>}>
        <Boom blow={false} />
      </PreviewErrorBoundary>,
    );
    expect(screen.getByText("preview")).toBeInTheDocument();
    expect(screen.queryByText(/fallback:/)).toBeNull();
  });

  // Retrying into the same failure must land back on the fallback, not on a
  // blank pane or a loop.
  it("stays on the fallback while the child keeps throwing", () => {
    const { rerender } = renderBoundary(true);
    rerender(
      <PreviewErrorBoundary fallback={(m) => <div>fallback: {m}</div>}>
        <Boom blow={true} />
      </PreviewErrorBoundary>,
    );
    expect(screen.getByText(/fallback: kaboom/)).toBeInTheDocument();
  });

  // #188 — the deploy form re-renders on every value change, recreating its
  // children each time. Resetting on that would throw again, over and over.
  describe("with resetKey", () => {
    const keyed = (blow: boolean, resetKey: unknown) => (
      <PreviewErrorBoundary resetKey={resetKey} fallback={(m) => <div>fallback: {m}</div>}>
        <Boom blow={blow} />
      </PreviewErrorBoundary>
    );

    it("keeps the fallback when only the children are recreated", () => {
      const spec = { fields: [] };
      const { rerender } = render(keyed(true, spec));
      expect(screen.getByText(/fallback: kaboom/)).toBeInTheDocument();
      // Same key, new child element (and even a child that would now render).
      rerender(keyed(false, spec));
      expect(screen.getByText(/fallback: kaboom/)).toBeInTheDocument();
    });

    it("tries again when the key changes", () => {
      const { rerender } = render(keyed(true, { fields: [] }));
      rerender(keyed(false, { fields: [{ path: "x" }] }));
      expect(screen.getByText("preview")).toBeInTheDocument();
      expect(screen.queryByText(/fallback:/)).toBeNull();
    });
  });
});
