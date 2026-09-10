import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { TopBarUserMenu } from "./TopBarUserMenu";

describe("TopBarUserMenu", () => {
  it("renders email and role badge", () => {
    render(<TopBarUserMenu email="a@b.co" role="admin" />);
    expect(screen.getByText("a@b.co")).toBeInTheDocument();
    expect(screen.getAllByText("Admin").length).toBeGreaterThan(0);
  });

  // #133 — the trigger would not shrink, so a long address pushed it past a
  // 390px viewport and gave every page a horizontal scrollbar.
  //
  // jsdom has no layout, so this asserts the two rules that make shrinking
  // possible rather than a measured width: `min-w-0` on the flex item (its
  // default `min-width: auto` is what refused to shrink) and `truncate` on
  // the text that has to give. The pixel result is asserted live.
  it("lets the trigger shrink below the address's natural width", () => {
    render(
      <TopBarUserMenu email="demo-admin@demo.kubeport" role="admin" />,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.className).toContain("min-w-0");
    const email = screen.getAllByText("demo-admin@demo.kubeport")[0];
    expect(email.className).toContain("truncate");
  });

  // Truncating the trigger would otherwise leave a narrow screen with no way
  // to read the whole address — `title` does not open on touch (#115) — so
  // the full address is repeated inside the menu.
  //
  // Not asserted here: base-ui portals the menu on open and jsdom has no
  // pointer events, so the content never mounts. That is why no test in this
  // repo opens a DropdownMenu or a Tooltip. Verified in the browser instead,
  // at 390px, where the trigger actually truncates.
  it("renders the trigger's copy of the address only, until the menu opens", () => {
    render(<TopBarUserMenu email="demo-admin@demo.kubeport" role="admin" />);
    expect(screen.getAllByText("demo-admin@demo.kubeport")).toHaveLength(1);
  });
});
