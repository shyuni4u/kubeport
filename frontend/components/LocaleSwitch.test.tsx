import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/tests/intl-test-utils";
import { LocaleSwitch } from "./LocaleSwitch";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  refresh.mockClear();
  document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
});

describe("LocaleSwitch", () => {
  it("selects a locale from the keyboard and refreshes the server-rendered text", async () => {
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitch />);
    const trigger = screen.getByRole("combobox", { name: "언어 선택" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(document.cookie).toContain("NEXT_LOCALE=en");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("Escape closes the menu without changing the language and returns focus", async () => {
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitch />);
    const trigger = screen.getByRole("combobox", { name: "언어 선택" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(refresh).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("NEXT_LOCALE=");
  });
});
