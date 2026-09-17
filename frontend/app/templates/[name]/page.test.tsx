import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("next/navigation", () => ({
  redirect: () => { throw new Error("REDIRECT"); },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api-server", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

import TemplateDetail from "./page";
import { ActionForm, type ActionState } from "@/components/ActionForm";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function json(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
  } as unknown as Response;
}

function render(name: string) {
  return TemplateDetail({ params: Promise.resolve({ name }) }) as Promise<ReactElement>;
}

// Every ActionForm's server action in the rendered tree, in render order.
function actionsIn(node: ReactNode): Action[] {
  if (Array.isArray(node)) return node.flatMap(actionsIn);
  if (!isValidElement(node)) return [];
  const props = node.props as { action?: Action; children?: ReactNode };
  const own = node.type === ActionForm && props.action ? [props.action] : [];
  return [...own, ...actionsIn(props.children)];
}

function routeTemplate(name: string) {
  apiFetch.mockImplementation(async (path) => {
    if (path === `/v1/templates/${name}`) {
      return json(200, { display_name: "Web", description: null, owning_team_id: null });
    }
    if (path === `/v1/templates/${name}/versions`) {
      return json(200, { versions: [{ id: "v1", version: 1, status: "draft", authoring_mode: "ui" }] });
    }
    if (path === "/v1/me") return json(200, { groups: ["kubeport-admin"] });
    return json(204);
  });
}

beforeEach(() => apiFetch.mockReset());

// #374 — the name param arrives decoded, so `%2F`·`%2e%2e` in the URL are
// `/`·`..` here and would walk the page's API calls — and the publish, deprecate
// and delete actions it renders — onto another /v1 route.
describe("template detail page, the name in API paths", () => {
  it.each(["..", "a/b", "../releases/3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f", "a\\b"])(
    "refuses %j before asking the API",
    async (name) => {
      await expect(render(name)).rejects.toThrow("NOT_FOUND");
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  // #375 keeps names from before its rule working.
  it("still opens a template named before the rule, as one encoded segment", async () => {
    routeTemplate("web%20App");
    await render("web App");
    expect(apiFetch).toHaveBeenCalledWith("/v1/templates/web%20App", undefined);
    expect(apiFetch).toHaveBeenCalledWith("/v1/templates/web%20App/versions", undefined);
  });
});

describe("template detail page, the version a form posts", () => {
  async function draftActions() {
    routeTemplate("WebApp");
    const [publish, deleteDraft] = actionsIn(await render("WebApp"));
    apiFetch.mockClear();
    return { publish, deleteDraft };
  }

  it.each(["1/publish", "../x", "0", "", "1.5"])(
    "sends nothing for a posted version of %j",
    async (version) => {
      const { publish, deleteDraft } = await draftActions();
      const form = new FormData();
      form.set("version", version);

      expect(await publish({}, form)).toEqual({ error: "generic" });
      expect(await deleteDraft({}, form)).toEqual({ error: "generic" });
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  it("publishes a real version under the encoded name", async () => {
    const { publish } = await draftActions();
    const form = new FormData();
    form.set("version", "1");

    expect(await publish({}, form)).toEqual({});
    expect(apiFetch).toHaveBeenCalledWith("/v1/templates/WebApp/versions/1/publish", { method: "POST" });
  });
});

 describe("whole template deletion", () => {
  it("deletes the encoded template and redirects", async () => {
    routeTemplate("web%20App");
    const actions = actionsIn(await render("web App"));
    apiFetch.mockResolvedValue(json(204));
    await expect(actions.at(-1)!({}, new FormData())).rejects.toThrow("REDIRECT");
    expect(apiFetch).toHaveBeenCalledWith("/v1/templates/web%20App", { method: "DELETE" });
  });
  it("explains when a release prevents deletion", async () => {
    routeTemplate("WebApp");
    const actions = actionsIn(await render("WebApp"));
    apiFetch.mockResolvedValue(json(409));
    expect(await actions.at(-1)!({}, new FormData())).toEqual({ error: "templateInUse" });
  });
 });
