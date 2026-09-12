import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { RelativeTime, RELATIVE_TIME_UPDATE_MS } from "./RelativeTime";
import { TIME_ZONE } from "@/i18n/request";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function renderAt(iso: string, locale: "ko" | "en" = "ko") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone={TIME_ZONE}
      now={NOW}
    >
      <RelativeTime iso={iso} />
    </NextIntlClientProvider>,
  );
}

describe("RelativeTime", () => {
  afterEach(() => cleanup());

  // #40 — `toLocaleString()` with no locale rendered "9/9/2026, 12:00:05 AM"
  // in a Korean UI. Spec §6.2 asks for a relative phrase instead.
  it("renders a relative phrase, not a wall-clock timestamp", () => {
    renderAt("2026-09-09T10:00:00.000Z");
    const text = screen.getByRole("time").textContent ?? "";
    expect(text).not.toMatch(/\d{4}/); // no year → not a formatted date
    expect(text).toMatch(/2/); // "2 hours ago" / "2시간 전"
  });

  // Compared across locales rather than matched against "전"/"ago": how much
  // ICU data the runtime ships varies (the CI runner and this machine format
  // the same locale differently), but "the app locale decides" must hold
  // everywhere.
  it("follows the app locale", () => {
    const iso = "2026-09-09T10:00:00.000Z";
    renderAt(iso);
    const koText = screen.getByRole("time").textContent;
    cleanup();
    renderAt(iso, "en");
    expect(screen.getByRole("time").textContent).not.toBe(koText);
  });

  // The exact timestamp is still reachable — relative time alone is useless
  // for "which deploy was this?".
  it("keeps a machine-readable dateTime", () => {
    const iso = "2026-09-09T10:00:00.000Z";
    renderAt(iso);
    expect(screen.getByRole("time")).toHaveAttribute("dateTime", iso);
  });

  // #115 — the absolute time was in `title` only: invisible to touch, to the
  // keyboard, and to anyone who never happened to hover. Asserted on the
  // rendered text rather than by opening the tooltip, because that is the
  // copy that needs no interaction at all to reach.
  //
  // 10:00Z is 19:00 in Asia/Seoul.
  it("renders the absolute time without requiring interaction", () => {
    renderAt("2026-09-09T10:00:00.000Z");
    expect(screen.getByRole("button").textContent).toMatch(/7:00|19:00/);
  });

  // #142 — the absolute time is pinned to Asia/Seoul, and an English reader
  // elsewhere read it as their own clock. Matched loosely: runtimes name the
  // zone "GMT+9", "UTC+9" or "KST" depending on their ICU data.
  it("names the time zone the absolute time is in", () => {
    renderAt("2026-09-09T10:00:00.000Z", "en");
    expect(screen.getByRole("button").textContent).toMatch(/GMT\+9|UTC\+9|KST/);
  });

  // Passing `timeZoneName` alongside `dateStyle` makes Intl throw, and
  // next-intl then prints `Date.toString()` — which also contains "GMT+0900",
  // so the test above alone would not catch it. Pin the formatted date too.
  it("keeps the formatted date when it adds the zone, not the raw Date string", () => {
    renderAt("2026-09-09T10:00:00.000Z", "en");
    const text = screen.getByRole("button").textContent ?? "";
    expect(text).toMatch(/Sep 9, 2026/);
    expect(text).not.toMatch(/Wed Sep|GMT\+0900/);
  });

  // Hover alone cannot reach a tooltip on a touch screen, and `title` cannot
  // be focused. The trigger is a button for both reasons (the HelpHint rule).
  it("exposes the timestamp through a focusable trigger", () => {
    renderAt("2026-09-09T10:00:00.000Z");
    const trigger = screen.getByRole("button");
    trigger.focus();
    expect(trigger).toHaveFocus();
    // No native title popup competing with the tooltip.
    expect(trigger).not.toHaveAttribute("title");
  });

  it("renders nothing for an unparseable timestamp", () => {
    renderAt("not-a-date");
    expect(screen.queryByRole("time")).toBeNull();
  });

  // #100 — the provider's `now` froze at the last full page load, so a release
  // created seven minutes into a client-side session read "7분 후 배포".
  // Nothing this renders is scheduled; a future stamp is clock disagreement.
  it("never shows a timestamp as being in the future", () => {
    renderAt("2026-09-09T12:07:00.000Z"); // seven minutes after the pinned now
    const future = screen.getByRole("time").textContent;
    cleanup();
    renderAt(NOW.toISOString());
    expect(future).toBe(screen.getByRole("time").textContent);
  });

  // The other half of #100: with a pinned `now` the phrase never moved while
  // the tab stayed open.
  it("keeps counting after it was rendered", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-09T12:30:00.000Z"));
      renderAt("2026-09-09T11:59:00.000Z"); // one minute before the pinned now
      const first = screen.getByRole("time").textContent;

      act(() => {
        vi.advanceTimersByTime(RELATIVE_TIME_UPDATE_MS);
      });

      // Now reads against the running clock (12:30:30), not the pinned 12:00.
      expect(screen.getByRole("time").textContent).not.toBe(first);
      expect(screen.getByRole("time")).toHaveAttribute("dateTime", "2026-09-09T11:59:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ReleaseHeader composes this through `t.rich` because Korean puts "배포"
// after the time and English puts "deployed" before it. Word order that lives
// in JSX cannot be translated — this pins that it lives in the message.
// ReleaseHeader itself is an async server component and is not unit-testable,
// so the composition is exercised here instead.
function DeployedAt({ iso }: { iso: string }) {
  const t = useTranslations("releases.meta");
  return <span>{t.rich("deployedAt", { time: () => <RelativeTime iso={iso} /> })}</span>;
}

describe("releases.meta.deployedAt", () => {
  afterEach(() => cleanup());

  function renderPhrase(locale: "ko" | "en") {
    return render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "ko" ? ko : en}
        timeZone={TIME_ZONE}
        now={NOW}
      >
        <DeployedAt iso="2026-09-09T10:00:00.000Z" />
      </NextIntlClientProvider>,
    );
  }

  // Asserted on the message file's own word ("배포" / "deployed") and its
  // position, never on the ICU-formatted time in between — that part varies
  // with the runtime's locale data.
  it("puts the verb after the time in Korean", () => {
    const { container } = renderPhrase("ko");
    expect(container.textContent?.trim()).toMatch(/배포$/);
  });

  it("puts the verb before the time in English", () => {
    const { container } = renderPhrase("en");
    expect(container.textContent?.trim()).toMatch(/^deployed /);
  });
});
