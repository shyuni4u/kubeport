import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const apiFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/api-server", () => ({ apiFetch: (path: string) => apiFetch(path) }));

import DeployPage from "./page";
import { DeployClient } from "./DeployClient";
import { UpdateValuesUnavailable } from "@/components/UpdateValuesUnavailable";

const ID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";

function json(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function route(release: () => Response) {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/v1/templates/web-app") {
      return json(200, { name: "web-app", current_version: 5, owning_team_name: null });
    }
    if (path === "/v1/templates/web-app/versions/5") {
      return json(200, { ui_spec_yaml: "fields: []\n" });
    }
    if (path === `/v1/releases/${ID}`) return release();
    if (path === "/v1/me") return json(200, { email: "someone@example.com" });
    return json(404);
  });
}

function render(name: string, updateReleaseId?: string) {
  return DeployPage({
    params: Promise.resolve({ name }),
    searchParams: Promise.resolve(updateReleaseId === undefined ? {} : { updateReleaseId }),
  }) as Promise<ReactElement<Record<string, unknown>>>;
}

beforeEach(() => apiFetch.mockReset());

// #296 (b) — this route has no way to load a release's values, so an update
// started here began from the ui-spec defaults.
describe("unversioned deploy page, updating a release", () => {
  it("redirects to the version the release runs, where its values are loaded", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 }, values_json: {} }));
    await expect(render("web-app", ID)).rejects.toThrow(
      `REDIRECT /catalog/web-app/versions/2/deploy?updateReleaseId=${ID}`,
    );
  });

  it("shows the unavailable state when the release could not be read", async () => {
    route(() => json(502));
    const el = await render("web-app", ID);
    expect(el.type).toBe(UpdateValuesUnavailable);
    expect(el.props).toEqual({ releaseId: ID });
  });

  it("does not redirect to another template's deploy page", async () => {
    route(() => json(200, { template: { name: "other-app", version: 2 }, values_json: {} }));
    await expect(render("web-app", ID)).rejects.toThrow("NOT_FOUND");
  });

  it("shows not found for a release that is gone or not yours", async () => {
    for (const status of [403, 404]) {
      route(() => json(status));
      await expect(render("web-app", ID)).rejects.toThrow("NOT_FOUND");
    }
  });

  it("builds no redirect from an id that is not one", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 }, values_json: {} }));
    await expect(render("web-app", "//evil.example")).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/v1/releases/"));
  });

  it("sends an expired session to sign in and back here", async () => {
    route(() => json(401));
    await expect(render("web-app", ID)).rejects.toThrow(
      `REDIRECT /?next=${encodeURIComponent(`/catalog/web-app/deploy?updateReleaseId=${ID}`)}`,
    );
  });

  it("renders the new-release form on the current version without an update id", async () => {
    route(() => json(500));
    const el = await render("web-app");
    expect(el.type).toBe(DeployClient);
    expect(el.props.version).toBe(5);
    expect(el.props.updateReleaseId).toBeUndefined();
  });
});
