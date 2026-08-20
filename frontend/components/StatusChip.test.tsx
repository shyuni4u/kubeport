import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusChip, statusChipVariantFromRelease } from "./StatusChip";

describe("StatusChip", () => {
  it("renders label with variant classes", () => {
    const { container } = render(<StatusChip variant="success">OK</StatusChip>);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("bg-green-100");
  });

  it("warning variant uses amber palette", () => {
    const { container } = render(<StatusChip variant="warning">...</StatusChip>);
    expect(container.firstChild).toHaveClass("bg-amber-100");
  });

  it("danger variant uses destructive palette", () => {
    const { container } = render(<StatusChip variant="danger">!</StatusChip>);
    // shadcn destructive variant uses bg-destructive/10
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toMatch(/destructive/);
  });
});

describe("statusChipVariantFromRelease", () => {
  it("maps 'healthy' → success", () => {
    expect(statusChipVariantFromRelease("healthy")).toBe("success");
  });
  it("maps 'warning' → warning", () => {
    expect(statusChipVariantFromRelease("warning")).toBe("warning");
  });
  it("maps 'error' / 'failed' → danger", () => {
    expect(statusChipVariantFromRelease("error")).toBe("danger");
    expect(statusChipVariantFromRelease("failed")).toBe("danger");
  });
  it("maps 'deprecated' / unknown → muted", () => {
    expect(statusChipVariantFromRelease("deprecated")).toBe("muted");
    expect(statusChipVariantFromRelease("xyz")).toBe("muted");
  });
});
