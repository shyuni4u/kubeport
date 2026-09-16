import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ErrorDetailProvider, useErrorDetail } from "./ErrorDetailProvider";
import userEvent from "@testing-library/user-event";
import { ErrorDetailSwitch } from "./ErrorDetailSwitch";

function LevelProbe() {
  return <output data-testid="level">{useErrorDetail().level}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = "kbp_error_detail=; Max-Age=0; Path=/";
});

describe("ErrorDetailSwitch", () => {
  it("is a labelled select starting at the server's level, with the three levels", async () => {
    render(
      <ErrorDetailProvider initial="raw">
        <ErrorDetailSwitch />
      </ErrorDetailProvider>,
    );
    const select = screen.getByRole("combobox", { name: "에러 표시" });
    expect(select).toHaveTextContent("원문");
    await userEvent.click(select);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "간단히",
      "자세히",
      "원문",
    ]);
  });

  it("choosing a level changes it for the page at once and writes the cookie", async () => {
    render(
      <ErrorDetailProvider initial="friendly">
        <ErrorDetailSwitch />
        <LevelProbe />
      </ErrorDetailProvider>,
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "자세히" }));
    expect(screen.getByTestId("level")).toHaveTextContent("detailed");
    expect(document.cookie).toContain("kbp_error_detail=detailed");
  });

  it("writes a host-only cookie on Path=/ with SameSite=Lax", async () => {
    const set = vi.spyOn(document, "cookie", "set");
    render(
      <ErrorDetailProvider initial="friendly">
        <ErrorDetailSwitch />
      </ErrorDetailProvider>,
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "원문" }));
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0].toLowerCase();
    expect(written).toContain("path=/");
    expect(written).not.toContain("domain=");
    expect(written).toContain("samesite=lax");
    expect(written).not.toContain("httponly");
  });
});
