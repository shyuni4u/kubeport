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
  // Asserted as "the two locales disagree", not as "ko contains 오후". The
  // day-period *names* depend on how much ICU data the runtime ships: this
  // machine renders "오후 03:00" but the CI runner renders "PM 03:00" for the
  // same locale. What the fix actually guarantees — and what the old code
  // broke — is that the app locale, not the runtime's, decides the format. So
  // compare the two renders: before the fix they were byte-identical.
  // Read the message span, not the whole banner: the dismiss button's label
  // butts right up against the time ("03:00 PMDismiss").
  const message = () =>
    screen.getByRole("status").firstElementChild?.textContent ?? "";

  it("formats the reset time in the app locale, not the runtime's", () => {
    renderBanner("ko");
    const koText = message();
    cleanup();
    renderBanner("en");
    const enText = message();

    // The surrounding sentence differs by locale too, so compare just the
    // formatted time — everything after the last colon-space.
    const timeOf = (s: string) => s.slice(s.lastIndexOf(": ") + 2);
    expect(timeOf(koText)).not.toBe(timeOf(enText));
  });

  // 06:00Z is 15:00 in Asia/Seoul — locale-independent, so this one can assert
  // the value directly.
  it("renders the time in the configured time zone", () => {
    renderBanner("ko");
    expect(message()).toMatch(/\b0?3:00\b/);
  });
});
