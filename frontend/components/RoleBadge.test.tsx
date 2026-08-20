import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "./RoleBadge";

describe("RoleBadge", () => {
  it("renders admin label when role=admin and withLabel", () => {
    render(<RoleBadge role="admin" withLabel />);
    expect(screen.getByText(/Admin · 템플릿 작성/)).toBeInTheDocument();
  });

  it("renders user label when role=user and withLabel", () => {
    render(<RoleBadge role="user" withLabel />);
    expect(screen.getByText(/User · 카탈로그 소비/)).toBeInTheDocument();
  });

  it("renders short label when withLabel is omitted", () => {
    render(<RoleBadge role="admin" />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByText(/템플릿 작성/)).not.toBeInTheDocument();
  });

  it("applies purple palette for admin", () => {
    const { container } = render(<RoleBadge role="admin" />);
    expect(container.firstChild).toHaveClass("bg-purple-50");
    expect(container.firstChild).toHaveClass("text-purple-800");
  });

  it("applies teal palette for user", () => {
    const { container } = render(<RoleBadge role="user" />);
    expect(container.firstChild).toHaveClass("bg-teal-50");
    expect(container.firstChild).toHaveClass("text-teal-800");
  });
});
