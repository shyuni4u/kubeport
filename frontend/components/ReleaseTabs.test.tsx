import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReleaseTabs } from "./ReleaseTabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/releases/abc/logs",
}));

describe("ReleaseTabs", () => {
  it("marks active tab by pathname suffix", () => {
    render(<ReleaseTabs releaseId="abc" />);
    const logsLink = screen.getByRole("link", { name: "로그" });
    expect(logsLink.className).toMatch(/border-primary/);
    const overviewLink = screen.getByRole("link", { name: "개요" });
    expect(overviewLink.className).not.toMatch(/border-primary/);
  });

  it("uses /releases/<id> as overview href", () => {
    render(<ReleaseTabs releaseId="abc" />);
    expect(screen.getByRole("link", { name: "개요" })).toHaveAttribute("href", "/releases/abc");
    expect(screen.getByRole("link", { name: "로그" })).toHaveAttribute("href", "/releases/abc/logs");
  });
});
