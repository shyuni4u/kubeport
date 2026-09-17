import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import starters from "@/lib/resource-starters.json";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/editor/EditorLayout", () => ({ EditorLayout: ({ tree, inspector }: { tree: ReactNode; inspector: ReactNode }) => <>{tree}{inspector}</> }));
vi.mock("@/components/YamlPreview", () => ({ YamlPreview: () => null }));
vi.mock("@/components/TemplateValidation", () => ({ TemplateValidation: () => null }));

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const fetchMock = vi.fn(async (url: string) => {
    const schemas = Object.fromEntries(starters.map(s => [s.kind, {
      type: "object", properties: { metadata: { type: "object", properties: { name: { type: "string" } } } },
      "x-kubernetes-group-version-kind": [{
        group: s.apiVersion.includes("/") ? s.apiVersion.split("/")[0] : "",
        version: "v1", kind: s.kind,
      }],
    }]));
    const data = url.endsWith("/clusters") ? { clusters: [{ name: "test" }] }
      : url.endsWith("/teams") ? { teams: [] }
      : url.endsWith("/openapi") ? { paths: {} }
      : url.includes("/openapi/") ? { components: { schemas } } : {};
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<NextIntlClientProvider locale="ko" messages={ko}><Page /></NextIntlClientProvider>);
  await screen.findByRole("button", { name: "Deployment" });
  fireEvent.change(screen.getByRole("textbox", { name: ko.templates.editor.meta.name }), { target: { value: "starter-test" } });
  return fetchMock;
}

it.each(starters)("saves a $kind draft after quick pick without extra resource input", async starter => {
  const fetchMock = await setup();
  fireEvent.click(screen.getByRole("button", { name: starter.kind }));
  const save = screen.getByRole("button", { name: ko.templates.editor.saveDraft });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/templates", expect.objectContaining({ method: "POST" })));
  const request = fetchMock.mock.calls.find(([url]) => url === "/api/v1/templates");
  const body = JSON.parse((request as unknown as [string, RequestInit])[1].body as string);
  expect(body.ui_state.resources[0].kind).toBe(starter.kind);
  expect(Object.keys(body.ui_state.resources[0].fields).length).toBeGreaterThan(0);
});

it("removes the selected resource and disables save when empty", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  await screen.findByRole("button", { name: "Deployment deployment-1 삭제" });
  fireEvent.click(screen.getByRole("treeitem", { name: /namestring/ }));
  expect(screen.getByText("Deployment[deployment-1].metadata.name")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Deployment deployment-1 삭제" }));
  expect(screen.queryByText("Deployment[deployment-1].metadata.name")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: ko.templates.editor.saveDraft })).toBeDisabled();
});

it("preserves the remaining selection and avoids duplicate names after removal and addition", async () => {
  const fetchMock = await setup();
  for (let i = 1; i <= 2; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
    await screen.findByRole("button", { name: `Deployment deployment-${i} 삭제` });
  }
  fireEvent.click(screen.getAllByRole("treeitem", { name: /namestring/ })[1]);
  fireEvent.click(screen.getByRole("button", { name: "Deployment deployment-1 삭제" }));
  expect(screen.getByText("Deployment[deployment-2].metadata.name")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  await screen.findByRole("button", { name: "Deployment deployment-1 삭제" });
  fireEvent.click(screen.getByRole("button", { name: ko.templates.editor.saveDraft }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/templates", expect.objectContaining({ method: "POST" })));
  const request = fetchMock.mock.calls.find(([url]) => url === "/api/v1/templates");
  const body = JSON.parse((request as unknown as [string, RequestInit])[1].body as string);
  expect(body.ui_state.resources.map((r: { name: string }) => r.name)).toEqual(["deployment-2", "deployment-1"]);
});

