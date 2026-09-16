import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ko from "@/messages/ko.json";

const apiFetch = vi.fn();
vi.mock("@/lib/api-server", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => ko.templates.editor[key as keyof typeof ko.templates.editor] }));
import NewTemplateLayout from "./layout";

describe("new template demo notice", () => {
  it.each(["demo-admin@demo.kubeport", "admin@example.com"])("only explains demo limits to %s when applicable", async (email) => {
    apiFetch.mockResolvedValue(Response.json({ email }));
    render(await NewTemplateLayout({ children: <p>Editor</p> }));
    expect(screen.getByText("Editor")).toBeInTheDocument();
    if (email.startsWith("demo-")) {
      expect(screen.getByRole("link", { name: "기존 템플릿에서 시작" })).toHaveAttribute("href", "/templates");
      expect(screen.getByText(/설치 설정에 따라 제한/)).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    }
  });
});
