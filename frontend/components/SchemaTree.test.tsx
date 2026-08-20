import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchemaTree } from "./SchemaTree";
import type { SchemaNode } from "@/lib/openapi";

// Minimal fixture: root.spec.replicas (integer).
// "spec" is expanded by default (see SchemaTree initial state),
// so spec.replicas renders without any user interaction.
const fixture: SchemaNode = {
  type: "object",
  properties: {
    spec: {
      type: "object",
      properties: {
        replicas: { type: "integer" },
      },
    },
  },
};

describe("SchemaTree", () => {
  it("renders no badges when fields prop is omitted", () => {
    const { container } = render(
      <SchemaTree schema={fixture} selectedPath={null} onSelect={() => {}} />,
    );
    expect(container.textContent).toContain("replicas");
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
    expect(screen.queryByText(/exposed/)).not.toBeInTheDocument();
  });

  it("renders the exposed badge when a path's mode is 'exposed'", () => {
    render(
      <SchemaTree
        schema={fixture}
        selectedPath={null}
        onSelect={() => {}}
        fields={{ "spec.replicas": { mode: "exposed" } }}
      />,
    );
    expect(screen.getByText(/● exposed/)).toBeInTheDocument();
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
  });

  it("renders the fixed badge when a path's mode is 'fixed'", () => {
    render(
      <SchemaTree
        schema={fixture}
        selectedPath={null}
        onSelect={() => {}}
        fields={{ "spec.replicas": { mode: "fixed" } }}
      />,
    );
    expect(screen.getByText("고정")).toBeInTheDocument();
    expect(screen.queryByText(/● exposed/)).not.toBeInTheDocument();
  });

  it("does not render badges on paths that are not in the fields map", () => {
    render(
      <SchemaTree
        schema={fixture}
        selectedPath={null}
        onSelect={() => {}}
        fields={{ "spec.otherPath": { mode: "exposed" } }}
      />,
    );
    expect(screen.queryByText(/● exposed/)).not.toBeInTheDocument();
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
  });
});
