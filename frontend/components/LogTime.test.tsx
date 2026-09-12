import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { LogTime } from "./LogTime";
import { TIME_ZONE } from "@/i18n/request";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// 05:53:56Z is 14:53:56 in Asia/Seoul — the live line from #270.
const MS = Date.parse("2026-09-12T05:53:56.000Z");

function renderIn(locale: "ko" | "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone={TIME_ZONE}>
      <LogTime ms={MS} />
    </NextIntlClientProvider>,
  );
}

// #270 — the English UI showed "오후 2:53:56": the browser's locale, not the app's.
describe("LogTime", () => {
  afterEach(() => cleanup());

  it("follows the app locale, not the browser's", () => {
    const { container } = renderIn("en");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/오전|오후/);
    expect(text).toMatch(/2:53:56|14:53:56/);
  });

  it("formats differently per app locale", () => {
    const koText = renderIn("ko").container.textContent;
    cleanup();
    expect(renderIn("en").container.textContent).not.toBe(koText);
  });

  // On a CI runner in UTC, the browser-zone version printed 5:53:56.
  it("uses the app's pinned time zone, whatever zone the runtime is in", () => {
    const { container } = renderIn("en");
    expect(container.textContent).not.toMatch(/5:53:56/);
  });
});
