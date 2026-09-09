import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { RelativeTime } from "./RelativeTime";
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
  // in a Korean UI. Spec §6.2 asks for "2시간 전" instead.
  it("renders a relative phrase in Korean", () => {
    renderAt("2026-09-09T10:00:00.000Z");
    expect(screen.getByRole("time")).toHaveTextContent(/전$/);
    expect(screen.getByRole("time").textContent).not.toMatch(/AM|PM/);
  });

  it("renders a relative phrase in English", () => {
    renderAt("2026-09-09T10:00:00.000Z", "en");
    expect(screen.getByRole("time")).toHaveTextContent(/ago$/);
  });

  // The exact timestamp is still reachable — relative time alone is useless
  // for "which deploy was this?".
  it("keeps the absolute time in the title and a machine-readable dateTime", () => {
    const iso = "2026-09-09T10:00:00.000Z";
    renderAt(iso);
    const el = screen.getByRole("time");
    expect(el).toHaveAttribute("dateTime", iso);
    // 10:00Z is 19:00 in Asia/Seoul.
    expect(el.getAttribute("title")).toMatch(/7:00|19:00/);
  });

  it("renders nothing for an unparseable timestamp", () => {
    renderAt("not-a-date");
    expect(screen.queryByRole("time")).toBeNull();
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

  it("puts the verb after the time in Korean", () => {
    const { container } = renderPhrase("ko");
    expect(container.textContent?.trim()).toMatch(/전 배포$/);
  });

  it("puts the verb before the time in English", () => {
    const { container } = renderPhrase("en");
    expect(container.textContent?.trim()).toMatch(/^deployed .*ago$/);
  });
});
