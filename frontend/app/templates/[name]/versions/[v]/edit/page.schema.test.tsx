import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "test", v: "1" }),
  usePathname: () => "/templates/test/versions/1/edit",
  useSearchParams: () => new URLSearchParams("mode=ui"),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/editor/EditorLayout", () => ({ EditorLayout: ({ tree, inspector, preview }: { tree: ReactNode; inspector: ReactNode; preview: ReactNode }) => <>{tree}{inspector}{preview}</> }));
vi.mock("@/components/YamlPreview", () => ({ YamlPreview: () => <div>valid YAML preview</div> }));
vi.mock("@/components/UserFormPreview", () => ({ UserFormPreview: () => <div>valid form preview</div> }));
afterEach(() => vi.unstubAllGlobals());

it("blocks a legacy ConfigMap object field, then restores preview and save after clearing it", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    const data = url.endsWith("/openapi/v1") ? {
      components: { schemas: { ConfigMap: { type: "object", "x-kubernetes-group-version-kind": [{ group: "", version: "v1", kind: "ConfigMap" }], properties: { data: { type: "object" } } } } },
    } : url.endsWith("/clusters") ? { clusters: [{ name: "test" }] }
      : url.endsWith("/versions/1") ? {
        authoring_mode: "ui", status: "draft",
        ui_state_json: { resources: [{ apiVersion: "v1", kind: "ConfigMap", name: "configmap-1", fields: { data: { mode: "exposed", uiSpec: { label: "Data", type: "string", default: "hi" } } } }] },
      } : { name: "test", tags: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<NextIntlClientProvider locale="ko" messages={ko}><Page /></NextIntlClientProvider>);
  const message = ko.templates.editor.errors.schemaTypeMismatch.replace("{path}", "ConfigMap[configmap-1].data");
  await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
  expect(screen.getByRole("button", { name: ko.templates.editor.saveDraft })).toBeDisabled();
  expect(screen.queryByText("valid YAML preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("treeitem", { name: /data/ }));
  expect(screen.getByRole("button", { name: ko.templates.editor.field.expose })).toBeDisabled();
  fireEvent.click(screen.getByText(ko.templates.editor.field.clear));
  await waitFor(() => expect(screen.getByRole("button", { name: ko.templates.editor.saveDraft })).toBeEnabled());
  expect(screen.getByText("valid YAML preview")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: ko.templates.editor.saveDraft }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/templates/test/versions/1", expect.objectContaining({ method: "PATCH", body: expect.not.stringContaining('"data"') })));
});
