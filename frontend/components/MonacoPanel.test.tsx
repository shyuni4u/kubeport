import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { useEffect } from "react";

// A stand-in for the dynamically imported editor: it mounts once, the way
// @monaco-editor/react does, handing over an editor and the monaco namespace.
const setModelMarkers = vi.fn();
const model = { id: "model" };
vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor({ onMount }: { onMount?: (editor: unknown, monaco: unknown) => void }) {
      useEffect(() => {
        onMount?.(
          { getModel: () => model },
          { editor: { setModelMarkers }, MarkerSeverity: { Error: 8, Warning: 4 } },
        );
        // Mount once, as the real editor does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    },
}));

import { MonacoPanel, type MonacoMarker } from "./MonacoPanel";

const marker = (severity: MonacoMarker["severity"], line: number): MonacoMarker => ({
  severity,
  message: `${severity} on ${line}`,
  startLineNumber: line,
  startColumn: 1,
  endLineNumber: line,
  endColumn: 5,
});

describe("MonacoPanel", () => {
  it("exports a function component", () => {
    expect(typeof MonacoPanel).toBe("function");
  });

  it("sets markers on mount and replaces them when they change", () => {
    setModelMarkers.mockClear();
    const { rerender } = render(<MonacoPanel value="a: 1" markers={[marker("error", 2)]} />);
    expect(setModelMarkers).toHaveBeenLastCalledWith(model, "kubeport", [
      { message: "error on 2", startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5, severity: 8 },
    ]);

    rerender(<MonacoPanel value="a: 1" markers={[marker("warning", 3)]} />);
    expect(setModelMarkers).toHaveBeenLastCalledWith(model, "kubeport", [
      expect.objectContaining({ startLineNumber: 3, severity: 4 }),
    ]);

    // Fixing the last problem has to clear the underline, not leave it.
    rerender(<MonacoPanel value="a: 1" markers={[]} />);
    expect(setModelMarkers).toHaveBeenLastCalledWith(model, "kubeport", []);
  });
});
