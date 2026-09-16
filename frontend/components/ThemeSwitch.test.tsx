import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import userEvent from "@testing-library/user-event";
import { ThemeSwitch } from "./ThemeSwitch";

function clearCookie() {
  document.cookie = "kbp_theme=; Max-Age=0; Path=/";
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark", "light");
  clearCookie();
});

describe("ThemeSwitch", () => {
  it("is a labelled select showing the server's value, with all three choices", async () => {
    render(<ThemeSwitch initial="dark" />);
    const select = screen.getByRole("combobox", { name: "색 테마" });
    expect(select).toHaveTextContent("다크");
    await userEvent.click(select);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "시스템 설정",
      "라이트",
      "다크",
    ]);
  });

  it("choosing dark writes the cookie and puts .dark on <html> without a reload", async () => {
    render(<ThemeSwitch initial="system" />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "다크" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.cookie).toContain("kbp_theme=dark");
    expect(screen.getByRole("combobox")).toHaveTextContent("다크");
  });

  it("choosing light replaces .dark with .light", async () => {
    document.documentElement.classList.add("dark");
    render(<ThemeSwitch initial="dark" />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "라이트" }));
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.cookie).toContain("kbp_theme=light");
  });

  // System carries no class, so the prefers-color-scheme rule decides.
  it("choosing system removes both theme classes and persists system", async () => {
    document.documentElement.classList.add("light");
    render(<ThemeSwitch initial="light" />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "시스템 설정" }));
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.cookie).toContain("kbp_theme=system");
  });

  // The header the browser stores is what matters, and jsdom's document.cookie
  // getter hides attributes, so assert the string that is written.
  it("writes a host-only cookie on Path=/ with SameSite=Lax", async () => {
    const set = vi.spyOn(document, "cookie", "set");
    render(<ThemeSwitch initial="system" />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "다크" }));
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0].toLowerCase();
    expect(written).toContain("path=/");
    expect(written).not.toContain("domain=");
    expect(written).toContain("samesite=lax");
    expect(written).not.toContain("httponly");
  });
});
