import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DemoBanner } from "./DemoBanner";
import { TIME_ZONE } from "@/i18n/request";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

const RESET_AT = "2026-09-07T06:00:00.000Z";

function renderBanner(locale: "ko" | "en" = "ko") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone={TIME_ZONE}
    >
      <DemoBanner resetAtIso={RESET_AT} />
    </NextIntlClientProvider>,
  );
}

describe("DemoBanner", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => cleanup());

  it("shows the next reset time and dismisses for the session", () => {
    renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent("데모 세션");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(sessionStorage.getItem("kbp_demo_banner_dismissed")).toBe("1");
  });

  // #40 — `toLocaleTimeString([])` follows the *browser*, not the app locale,
  // so an English UI rendered "Next reset: 오후 03:00".
  //
  // Asserted in both directions on purpose. The old code produced one string
  // regardless of the app locale, so whatever the machine running the suite is
  // set to, one of these two must fail — a single-locale assertion would pass
  // by luck on a matching machine.
  // Read the message span, not the whole banner: the dismiss button's label
  // butts right up against the time ("03:00 PMDismiss") and eats the \b.
  const message = () =>
    screen.getByRole("status").firstElementChild?.textContent ?? "";

  it("formats the reset time in the app locale, not the runtime's", () => {
    renderBanner("ko");
    const koText = message();
    cleanup();
    renderBanner("en");
    const enText = message();

    expect(koText).toMatch(/오전|오후/);
    expect(koText).not.toMatch(/\bAM\b|\bPM\b/);
    expect(enText).toMatch(/\bAM\b|\bPM\b/);
    expect(enText).not.toMatch(/오전|오후/);
  });

  // 06:00Z is 15:00 in Asia/Seoul. Pinning the zone keeps the server and the
  // browser from disagreeing during hydration.
  it("renders the time in the configured time zone", () => {
    renderBanner("ko");
    expect(screen.getByRole("status").textContent).toMatch(/오후 0?3:00/);
  });
});
