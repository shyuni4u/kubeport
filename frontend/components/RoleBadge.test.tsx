import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { RoleBadge } from "./RoleBadge";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

function renderIn(locale: "ko" | "en", ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("RoleBadge", () => {
  it("renders admin label when role=admin and withLabel", () => {
    renderIn("ko", <RoleBadge role="admin" withLabel />);
    expect(screen.getByText(/Admin · 템플릿 작성/)).toBeInTheDocument();
  });

  it("renders user label when role=user and withLabel", () => {
    renderIn("ko", <RoleBadge role="user" withLabel />);
    expect(screen.getByText(/User · 카탈로그 소비/)).toBeInTheDocument();
  });

  // #40 — the long labels were hardcoded Korean, so an English UI showed
  // "User · 카탈로그 소비" in its own top bar.
  it("translates the long label for en", () => {
    renderIn("en", <RoleBadge role="user" withLabel />);
    expect(screen.getByText(/User · consumes the catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/카탈로그/)).not.toBeInTheDocument();
  });

  it("translates the admin long label for en", () => {
    renderIn("en", <RoleBadge role="admin" withLabel />);
    expect(screen.getByText(/Admin · authors templates/i)).toBeInTheDocument();
  });

  // "Admin" / "User" are the role names themselves — deliberately not
  // translated, so the short badge stays identical in both locales.
  it("renders short label when withLabel is omitted", () => {
    renderIn("ko", <RoleBadge role="admin" />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByText(/템플릿 작성/)).not.toBeInTheDocument();
  });

  it("applies purple palette for admin", () => {
    const { container } = renderIn("ko", <RoleBadge role="admin" />);
    expect(container.firstChild).toHaveClass("bg-purple-50");
    expect(container.firstChild).toHaveClass("text-purple-800");
  });

  it("applies teal palette for user", () => {
    const { container } = renderIn("ko", <RoleBadge role="user" />);
    expect(container.firstChild).toHaveClass("bg-teal-50");
    expect(container.firstChild).toHaveClass("text-teal-800");
  });
});
