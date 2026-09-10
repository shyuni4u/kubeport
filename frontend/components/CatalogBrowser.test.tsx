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

  // #32 — `name` is the identifier users see everywhere else (URLs, release
  // rows, the deploy form header), so it is the first thing they type.
  it("filters by search (matches name)", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "db");
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.queryByText("Web Service")).not.toBeInTheDocument();
  });

  it("filters by search (matches a tag)", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "backend");
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
    expect(screen.queryByText("Database")).not.toBeInTheDocument();
  });

  it("search is case-insensitive across every searched field", async () => {
    render(<CatalogBrowser templates={sample} />);
    await userEvent.type(screen.getByPlaceholderText(/검색/), "DB");
    expect(screen.getByText("Database")).toBeInTheDocument();
  });

  /**
   * #110. The tag chips filtered for real — clicking `batch` cut the catalog
   * from three cards to one — while every chip's computed style stayed
   * identical: no fill, no border, `cursor: default`, `data-state` unset. The
   * catalog was filtered and nothing on screen said so or said how to undo it.
   *
   * The design spec (§4.2) had specified "tag filter (ToggleGroup, '전체'
   * selected first)" all along; the '전체' item was simply never built, which
   * is why there was no way back.
   */
  describe("tag filter", () => {
    const pressed = () =>
      screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent);

    it("offers '전체' as the first chip and starts on it", () => {
      render(<CatalogBrowser templates={sample} />);
      const chips = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
      expect(chips[0]).toHaveTextContent("전체");
      expect(pressed()).toEqual(["전체"]);
    });

    it("marks the chosen tag as pressed, and only that one", async () => {
      render(<CatalogBrowser templates={sample} />);
      await userEvent.click(screen.getByRole("button", { name: "web" }));
      expect(pressed()).toEqual(["web"]);
    });

    it("'전체' clears the filter — the way back the reviewer could not find", async () => {
      render(<CatalogBrowser templates={sample} />);
      await userEvent.click(screen.getByRole("button", { name: "web" }));
      expect(screen.queryByText("Database")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "전체" }));
      expect(screen.getByText("Database")).toBeInTheDocument();
      expect(screen.getByText("API Gateway")).toBeInTheDocument();
      expect(pressed()).toEqual(["전체"]);
    });

    it("clicking the pressed tag again also clears it", async () => {
      // ToggleGroup's own deselect path. Without '전체' this was the *only* way
      // back and it is undiscoverable; with '전체' it still has to keep working,
      // or the two controls disagree about what is filtered.
      render(<CatalogBrowser templates={sample} />);
      const web = screen.getByRole("button", { name: "web" });
      await userEvent.click(web);
      await userEvent.click(web);
      expect(screen.getByText("Database")).toBeInTheDocument();
      expect(pressed()).toEqual(["전체"]);
    });
  });

  // Also #110, the note at the end: with `auto-fit`, a single surviving card
  // stretched from 403px to 1232px and stopped looking like a card at all.
  // `auto-fill` keeps the empty tracks, so the card keeps its size.
  it("keeps card width stable when one result is left", () => {
    const { container } = render(<CatalogBrowser templates={sample} />);
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("auto-fill");
    expect(grid?.className).not.toContain("auto-fit");
  });
});
