import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { CatalogCard, type CatalogCardTemplate } from "./CatalogCard";

const base: CatalogCardTemplate = {
  name: "web-service",
  display_name: "Web Service",
  description: "간단한 웹 서비스 배포 템플릿",
  tags: ["web"],
  current_version: 2,
  owning_team_name: "platform",
};

describe("CatalogCard", () => {
  it("renders display_name, description, version, team", () => {
    render(<CatalogCard template={base} />);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.getByText("간단한 웹 서비스 배포 템플릿")).toBeInTheDocument();
    expect(screen.getByText(/v2/)).toBeInTheDocument();
    expect(screen.getByText(/platform/)).toBeInTheDocument();
  });

  it("renders tag badges", () => {
    render(<CatalogCard template={{ ...base, tags: ["web", "public"] }} />);
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
  });

  it("links to /catalog/{name}/deploy", () => {
    render(<CatalogCard template={base} />);
    const link = screen.getByRole("link", { name: /배포하기/ });
    expect(link).toHaveAttribute("href", "/catalog/web-service/deploy");
  });

  it("falls back gracefully when description is null", () => {
    render(<CatalogCard template={{ ...base, description: null }} />);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
  });
});
