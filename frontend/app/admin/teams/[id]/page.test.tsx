import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("next/navigation", () => ({
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

import TeamDetailPage from "./page";
import { ActionForm, type ActionState } from "@/components/ActionForm";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

const TID = "7b1d0c52-3e4f-4a6b-9c8d-2e1f0a9b8c7d";
const UID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";

function json(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
  } as unknown as Response;
}

function render(id: string) {
  return TeamDetailPage({ params: Promise.resolve({ id }) }) as Promise<ReactElement>;
}

function actionsIn(node: ReactNode): Action[] {
  if (Array.isArray(node)) return node.flatMap(actionsIn);
  if (!isValidElement(node)) return [];
  const props = node.props as { action?: Action; children?: ReactNode };
  const own = node.type === ActionForm && props.action ? [props.action] : [];
  return [...own, ...actionsIn(props.children)];
}

beforeEach(() => apiFetch.mockReset());

// #374 (security review) — the id param arrives decoded, and the member form
// posts a user_id; either could carry what sends a call to another route.
describe("team detail page, values in API paths", () => {
  it.each(["..", "a/b", "a\\b"])("refuses the team id %j before asking the API", async (id) => {
    await expect(render(id)).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  // One segment, so it is encoded rather than refused: the backend answers a
  // malformed id itself, and the call cannot reach another route.
  it("encodes a `?` in the team id instead of cutting the path at it", async () => {
    apiFetch.mockResolvedValue(json(404));
    await expect(render("?")).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).toHaveBeenCalledWith("/v1/teams/%3F/members", undefined);
  });

  async function removeMember() {
    apiFetch.mockImplementation(async (path) => {
      if (path === `/v1/teams/${TID}/members`) {
        return json(200, { members: [{ user_id: UID, role: "editor", email: "a@example.com", user_display_name: null }] });
      }
      if (path === "/v1/teams") return json(200, { teams: [{ id: TID, name: "platform" }] });
      if (path === "/v1/me") return json(200, { email: "admin@example.com" });
      return json(204);
    });
    const [remove] = actionsIn(await render(TID));
    apiFetch.mockClear();
    return remove;
  }

  it.each(["..", "a/b", ""])("sends nothing for a posted user_id of %j", async (uid) => {
    const remove = await removeMember();
    const form = new FormData();
    form.set("user_id", uid);

    expect(await remove({}, form)).toEqual({ error: "generic" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("removes a real member under the encoded ids", async () => {
    const remove = await removeMember();
    const form = new FormData();
    form.set("user_id", UID);

    expect(await remove({}, form)).toEqual({});
    expect(apiFetch).toHaveBeenCalledWith(`/v1/teams/${TID}/members/${UID}`, { method: "DELETE" });
  });
});
