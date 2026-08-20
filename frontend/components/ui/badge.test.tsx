import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Badge } from "./badge";

describe("Badge variants", () => {
  it("renders success variant with green palette", () => {
    const { container } = render(<Badge variant="success">ok</Badge>);
    expect(container.firstChild).toHaveClass("bg-green-100");
  });
  it("renders warning variant with amber palette", () => {
    const { container } = render(<Badge variant="warning">wip</Badge>);
    expect(container.firstChild).toHaveClass("bg-amber-100");
  });
  it("renders muted variant with muted token palette", () => {
    const { container } = render(<Badge variant="muted">off</Badge>);
    expect(container.firstChild).toHaveClass("bg-muted");
    expect(container.firstChild).toHaveClass("text-muted-foreground");
  });
});
