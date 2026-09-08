import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { SchemaTree } from "./SchemaTree";
import type { SchemaNode } from "@/lib/openapi";
import ko from "@/messages/ko.json";

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

function renderTree(props: Partial<React.ComponentProps<typeof SchemaTree>> = {}) {
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <SchemaTree schema={fixture} selectedPath={null} onSelect={() => {}} {...props} />
    </NextIntlClientProvider>,
  );
}

describe("SchemaTree", () => {
  it("renders no badges when fields prop is omitted", () => {
    const { container } = renderTree();
    expect(container.textContent).toContain("replicas");
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
    expect(screen.queryByText(/노출/)).not.toBeInTheDocument();
  });

  it("renders the exposed badge when a path's mode is 'exposed'", () => {
    renderTree({ fields: { "spec.replicas": { mode: "exposed" } } });
    expect(screen.getByText(/● 노출/)).toBeInTheDocument();
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
  });

  it("renders the fixed badge when a path's mode is 'fixed'", () => {
    renderTree({ fields: { "spec.replicas": { mode: "fixed" } } });
    expect(screen.getByText("고정")).toBeInTheDocument();
    expect(screen.queryByText(/● 노출/)).not.toBeInTheDocument();
  });

  it("does not render badges on paths that are not in the fields map", () => {
    renderTree({ fields: { "spec.otherPath": { mode: "exposed" } } });
    expect(screen.queryByText(/● 노출/)).not.toBeInTheDocument();
    expect(screen.queryByText("고정")).not.toBeInTheDocument();
  });

  it("exposes nodes as keyboard-focusable treeitems with aria state", () => {
    const onSelect = vi.fn();
    renderTree({ onSelect, selectedPath: "spec.replicas" });
    expect(screen.getByRole("tree")).toBeInTheDocument();
    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBe(2);
    const spec = items.find((el) => el.textContent?.startsWith("▾ spec"))!;
    expect(spec.tagName).toBe("BUTTON");
    expect(spec).toHaveAttribute("aria-expanded", "true");
    expect(spec).toHaveAttribute("aria-selected", "false");
    const replicas = items.find((el) => el.textContent?.includes("replicas"))!;
    expect(replicas).toHaveAttribute("aria-selected", "true");
    expect(replicas).not.toHaveAttribute("aria-expanded");
    expect(screen.getByRole("group")).toBeInTheDocument();

    fireEvent.click(replicas);
    expect(onSelect).toHaveBeenCalledWith("spec.replicas", { type: "integer" });
  });
});
