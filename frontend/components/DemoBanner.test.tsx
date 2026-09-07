import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, beforeEach } from "vitest";
import { DemoBanner } from "./DemoBanner";
import ko from "@/messages/ko.json";

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <DemoBanner resetAtIso="2026-09-07T06:00:00.000Z" />
    </NextIntlClientProvider>,
  );
}

describe("DemoBanner", () => {
  beforeEach(() => sessionStorage.clear());
  it("shows the next reset time and dismisses for the session", () => {
    renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("데모 세션");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(sessionStorage.getItem("kbp_demo_banner_dismissed")).toBe("1");
  });
});
