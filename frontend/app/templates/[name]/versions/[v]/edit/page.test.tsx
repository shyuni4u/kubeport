import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "web-app", v: "2" }),
  usePathname: () => "/templates/web-app/versions/2/edit",
  useSearchParams: () => new URLSearchParams("mode=yaml"),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/YamlEditor", () => ({ YamlEditor: ({ label }: { label: string }) => <div>{label}</div> }));
vi.mock("@/components/UserFormPreview", () => ({ UserFormPreview: () => null }));

let status = "draft";
beforeEach(() => {
  status = "draft";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    authoring_mode: "yaml", status,
    resources_yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata: {}",
    ui_spec_yaml: "fields: []",
  }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

function show(locale: "ko" | "en") {
  render(<NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="UTC"><Page /></NextIntlClientProvider>);
}

describe("YAML editor context", () => {
  it.each([
    ["ko", "draft", "초안"], ["en", "draft", "Draft"],
    ["ko", "published", "게시됨"], ["en", "published", "Published"],
    ["ko", "deprecated", "사용 중단"], ["en", "deprecated", "Deprecated"],
  ] as const)("shows %s %s context", async (locale, state, label) => {
    status = state;
    show(locale);
    expect(await screen.findByRole("heading", { name: "web-app v2", level: 1 })).toBeVisible();
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    if (state !== "draft") {
      const messages = locale === "ko" ? ko : en;
      expect(screen.getByText(messages.templates.editor.convert.nonDraftYaml
        .replace("{version}", "2").replace("{status}", label))).toBeVisible();
    }
  });

  it("keeps the error instead of showing a misleading editor heading for a missing version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    show("ko");
    expect(await screen.findByText(ko.templates.editor.errors.versionLoad.replace("{version}", "2"))).toBeVisible();
    expect(screen.queryByRole("heading", { name: "web-app v2", level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("resources.yaml")).not.toBeInTheDocument();
  });
});
