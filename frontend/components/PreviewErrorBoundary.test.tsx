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
});
