import { describe, it, expect, vi } from "vitest";
import { screen, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import koMessages from "@/messages/ko.json";
import enMessages from "@/messages/en.json";

// Resolve a dotted message key against a locale dictionary, mimicking the
// next-intl `t(key, params)` lookup with `{var}` interpolation. Keeps tests
// isolated from next-intl's runtime — vitest runs in jsdom which next-intl
// treats as a Client Component context, so calling `getTranslations` directly
// throws.
type MessageDict = Record<string, unknown>;
function lookup(dict: MessageDict, key: string): string {
  const path = key.split(".");
  let cur: unknown = dict;
  for (const seg of path) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return key;
    }
  }
  return typeof cur === "string" ? cur : key;
}
function makeT(messages: MessageDict, namespace = "") {
  return (key: string, params?: Record<string, string | number>) => {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    let raw = lookup(messages, fullKey);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        raw = raw.replaceAll(`{${k}}`, String(v));
      }
    }
    return raw;
  };
}

let activeMessages: MessageDict = koMessages;
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) =>
    makeT(activeMessages, namespace ?? ""),
}));

// Banner embeds `<ForceDeleteButton>` (when isAdmin), which calls `useRouter`.
// jsdom has no app router mounted; stub it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

// Late import: must come after vi.mock so the banner picks up the mocked
// `next-intl/server` instead of the real one.
const { ReleaseStaleBanner } = await import("./ReleaseStaleBanner");

async function renderBanner(
  props: Parameters<typeof ReleaseStaleBanner>[0],
  locale: "ko" | "en" = "ko",
) {
  const messages = locale === "ko" ? koMessages : enMessages;
  activeMessages = messages;
  const ui = await ReleaseStaleBanner(props);
  // Wrap with NextIntlClientProvider so the embedded `<ForceDeleteButton>`
  // (a Client Component using `useTranslations`) gets a context. Without it
  // the admin variant blows up at render time.
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("ReleaseStaleBanner", () => {
  it("admin sees force-delete button, no contactAdmin hint", async () => {
    await renderBanner({
      status: "cluster-unreachable",
      releaseId: "rel-1",
      cluster: "kind",
      isAdmin: true,
    });
    expect(screen.getByText("클러스터에 접근할 수 없습니다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "강제 삭제" })).toBeInTheDocument();
    expect(
      screen.queryByText("이 릴리스를 정리하려면 관리자에게 문의하세요."),
    ).toBeNull();
  });

  it("non-admin sees contactAdmin hint, no button", async () => {
    await renderBanner({
      status: "cluster-unreachable",
      releaseId: "rel-1",
      cluster: "kind",
      isAdmin: false,
    });
    expect(
      screen.getByText("이 릴리스를 정리하려면 관리자에게 문의하세요."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "강제 삭제" })).toBeNull();
  });

  it("renders distinct titles per status", async () => {
    const { unmount } = await renderBanner({
      status: "cluster-unreachable",
      releaseId: "r",
      cluster: "kind",
      isAdmin: false,
    });
    expect(screen.getByText("클러스터에 접근할 수 없습니다")).toBeInTheDocument();
    unmount();

    await renderBanner({
      status: "resources-missing",
      releaseId: "r",
      cluster: "kind",
      isAdmin: false,
    });
    expect(
      screen.getByText("클러스터에 해당 리소스가 없습니다"),
    ).toBeInTheDocument();
  });

  it("interpolates the cluster name into the body", async () => {
    await renderBanner({
      status: "cluster-unreachable",
      releaseId: "r",
      cluster: "production-1",
      isAdmin: false,
    });
    expect(screen.getByText(/production-1/)).toBeInTheDocument();
  });

  it("renders English body when locale=en", async () => {
    await renderBanner(
      {
        status: "cluster-unreachable",
        releaseId: "r",
        cluster: "kind",
        isAdmin: false,
      },
      "en",
    );
    expect(screen.getByText("Cluster is unreachable")).toBeInTheDocument();
    expect(screen.getByText("Contact an admin to clean up this release.")).toBeInTheDocument();
  });

  it("ko/en messages cover the same keys for stale namespace", () => {
    // Catch missing-key drift early — both locales must define the same shape
    // for the whole `releases.stale` subtree, otherwise rendering one in a
    // locale missing keys will throw at runtime.
    function keysOf(obj: Record<string, unknown>, prefix = ""): string[] {
      return Object.entries(obj).flatMap(([k, v]) => {
        const here = prefix ? `${prefix}.${k}` : k;
        return v && typeof v === "object"
          ? keysOf(v as Record<string, unknown>, here)
          : [here];
      });
    }
    const ko = keysOf((koMessages.releases as Record<string, unknown>).stale as Record<string, unknown>);
    const en = keysOf((enMessages.releases as Record<string, unknown>).stale as Record<string, unknown>);
    expect(ko.sort()).toEqual(en.sort());
  });
});
