import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import koMessages from "@/messages/ko.json";
import enMessages from "@/messages/en.json";

// Same shape as ReleaseStaleBanner.test.tsx: `getTranslations` is a Server
// Component API that throws under jsdom, so it is replaced with a dotted-key
// lookup over the real dictionaries.
type MessageDict = Record<string, unknown>;
function lookup(dict: MessageDict, key: string): string {
  let cur: unknown = dict;
  for (const seg of key.split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return key;
    }
  }
  return typeof cur === "string" ? cur : key;
}
let activeMessages: MessageDict = koMessages;
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => (key: string) =>
    lookup(activeMessages, namespace ? `${namespace}.${key}` : key),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { ReleaseHeader } = await import("./ReleaseHeader");

const base = {
  id: "10638e9f-4a73-4cb7-973e-e5a5732c3d45",
  name: "hello-web",
  status: "healthy",
  template: { name: "web-app", version: 1 },
  cluster: "oci-a1",
  namespace: "demo",
};

async function renderHeader(data: Partial<typeof base>, locale: "ko" | "en" = "ko") {
  const messages = locale === "ko" ? koMessages : enMessages;
  activeMessages = messages;
  const ui = await ReleaseHeader({ data: { ...base, ...data } });
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// #354 — a healthy release's page had no way into the update form; the only
// link lived in the problem banner, so a reader with nothing wrong could not
// change a value without retyping the URL.
describe("ReleaseHeader update entry", () => {
  it("links a healthy release to the version-pinned update form", async () => {
    await renderHeader({});
    const link = screen.getByRole("link", { name: "설정 바꾸기" });
    expect(link).toHaveAttribute(
      "href",
      `/catalog/web-app/versions/1/deploy?updateReleaseId=${base.id}`,
    );
  });

  it("pins the release's own version, not the template's newest", async () => {
    await renderHeader({ template: { name: "web-app", version: 2 } });
    expect(screen.getByRole("link", { name: "설정 바꾸기" })).toHaveAttribute(
      "href",
      `/catalog/web-app/versions/2/deploy?updateReleaseId=${base.id}`,
    );
  });

  it("percent-encodes the template name in the path", async () => {
    await renderHeader({ template: { name: "my app/v1", version: 1 } });
    expect(screen.getByRole("link", { name: "설정 바꾸기" })).toHaveAttribute(
      "href",
      `/catalog/my%20app%2Fv1/versions/1/deploy?updateReleaseId=${base.id}`,
    );
  });

  it("keeps the link next to delete for warning and error releases", async () => {
    for (const status of ["warning", "error", "unknown"]) {
      const { unmount } = await renderHeader({ status });
      expect(screen.getByRole("link", { name: "설정 바꾸기" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
      unmount();
    }
  });

  it("hides it with delete on stale releases, which the banner handles", async () => {
    for (const status of ["cluster-unreachable", "resources-missing"]) {
      const { unmount } = await renderHeader({ status });
      expect(screen.queryByRole("link", { name: "설정 바꾸기" })).toBeNull();
      expect(screen.queryByRole("button", { name: "삭제" })).toBeNull();
      unmount();
    }
  });

  it("is translated in English", async () => {
    await renderHeader({}, "en");
    expect(screen.getByRole("link", { name: "Change settings" })).toBeInTheDocument();
  });
});
