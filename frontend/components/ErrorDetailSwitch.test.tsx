import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ErrorDetailProvider, useErrorDetail } from "./ErrorDetailProvider";
import { ErrorDetailSwitch } from "./ErrorDetailSwitch";

function LevelProbe() {
  return <output data-testid="level">{useErrorDetail().level}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = "kbp_error_detail=; Max-Age=0; Path=/";
});

describe("ErrorDetailSwitch", () => {
  it("is a labelled select starting at the server's level, with the three levels", () => {
    render(
      <ErrorDetailProvider initial="raw">
        <ErrorDetailSwitch />
      </ErrorDetailProvider>,
    );
    const select = screen.getByRole("combobox", { name: "에러 표시" });
    expect(select).toHaveValue("raw");
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual([
      "friendly",
      "detailed",
      "raw",
    ]);
  });

  it("choosing a level changes it for the page at once and writes the cookie", () => {
    render(
      <ErrorDetailProvider initial="friendly">
        <ErrorDetailSwitch />
        <LevelProbe />
      </ErrorDetailProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "detailed" } });
    expect(screen.getByTestId("level")).toHaveTextContent("detailed");
    expect(document.cookie).toContain("kbp_error_detail=detailed");
  });

  it("writes a host-only cookie on Path=/ with SameSite=Lax", () => {
    const set = vi.spyOn(document, "cookie", "set");
    render(
      <ErrorDetailProvider initial="friendly">
        <ErrorDetailSwitch />
      </ErrorDetailProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "raw" } });
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0].toLowerCase();
    expect(written).toContain("path=/");
    expect(written).not.toContain("domain=");
    expect(written).toContain("samesite=lax");
    expect(written).not.toContain("httponly");
  });
});
