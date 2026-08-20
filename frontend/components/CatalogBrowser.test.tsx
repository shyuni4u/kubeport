import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import userEvent from "@testing-library/user-event";
import { CatalogBrowser } from "./CatalogBrowser";

const sample = [
  { name: "web", display_name: "Web Service", description: "웹 배포", tags: ["web", "public"], current_version: 2, owning_team_name: "platform" },
  { name: "db", display_name: "Database", description: "PostgreSQL", tags: ["database"], current_version: 1, owning_team_name: "data" },
  { name: "api", display_name: "API Gateway", description: "내부 API", tags: ["backend"], current_version: 3, owning_team_name: "platform" },
];

describe("CatalogBrowser", () => {
  it("renders all templates initially", () => {
    render(<CatalogBrowser templates={sample} />);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
  });

  it("filters by search (matches display_name)", async () => {
    render(<CatalogBrowser templates={sample} />);
    const search = screen.getByPlaceholderText(/검색/);
    await userEvent.type(search, "API");
    expect(screen.queryByText("Web Service")).not.toBeInTheDocument();
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
  });

  it("filters by search (matches description)", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "PostgreSQL");
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.queryByText("Web Service")).not.toBeInTheDocument();
  });

  it("filters by tag (AND with search)", async () => {
    render(<CatalogBrowser templates={sample} />);
    const webTag = screen.getByRole("button", { name: "web" });
    await userEvent.click(webTag);
    expect(screen.getByText("Web Service")).toBeInTheDocument();
    expect(screen.queryByText("Database")).not.toBeInTheDocument();
  });

  it("shows empty state when no matches", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "xyzNoMatch");
    expect(screen.getByText(/일치하는 템플릿이 없습니다/)).toBeInTheDocument();
  });

  it("shows admin-empty state when templates array is empty", () => {
    render(<CatalogBrowser templates={[]} />);
    expect(screen.getByText(/관리자가 아직 템플릿을 만들지 않았습니다/)).toBeInTheDocument();
  });
});
