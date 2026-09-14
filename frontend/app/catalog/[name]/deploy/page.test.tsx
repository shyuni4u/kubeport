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

// #374 — the name param arrives decoded, so `%2F`·`%2e%2e` in the URL are
// `/`·`..` here and would put the page's API calls on another /v1 route.
describe("unversioned deploy page, the name in API paths", () => {
  it.each(["..", "a/b", `../releases/${ID}`, "a\\b"])(
    "refuses %j before asking the API",
    async (name) => {
      apiFetch.mockResolvedValue(json(200, {}));
      await expect(render(name)).rejects.toThrow("NOT_FOUND");
      await expect(render(name, ID)).rejects.toThrow("NOT_FOUND");
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  // #375 keeps names from before its rule working.
  it.each([
    ["WebApp", "/v1/templates/WebApp"],
    ["web app", "/v1/templates/web%20app"],
  ])("still asks for a template named %j, as one encoded segment", async (name, path) => {
    apiFetch.mockResolvedValue(json(404));
    await expect(render(name)).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).toHaveBeenCalledWith(path);
  });
});

// #190 — the form holds a new release's name to what a multi-instance
// version's objects leave, read from the version's own resources.
describe("unversioned deploy page, name rules", () => {
  function routeVersion(version: { ui_spec_yaml: string; resources_yaml: string }, email = "someone@example.com") {
    apiFetch.mockImplementation(async (path) => {
      if (path === "/v1/templates/web-app") {
        return json(200, { name: "web-app", current_version: 5, owning_team_name: null });
      }
      if (path === "/v1/templates/web-app/versions/5") return json(200, version);
      if (path === "/v1/me") return json(200, { email });
      return json(404);
    });
  }
  const resources = "kind: Service\nmetadata:\n  name: web\n---\nkind: CronJob\nmetadata:\n  name: nightly-backup\n";

  it("hands the form a multi-instance version's limits", async () => {
    routeVersion({ ui_spec_yaml: "instances: multiple\nfields: []\n", resources_yaml: resources });
    const el = await render("web-app");
    expect(el.props.nameRules).toEqual({ multiple: true, maxLength: 37, letterFirst: true });
  });

  it("keeps a single-instance version's name as it was", async () => {
    routeVersion({ ui_spec_yaml: "fields: []\n", resources_yaml: resources });
    const el = await render("web-app");
    expect(el.props.nameRules).toEqual({ multiple: false, maxLength: 63, letterFirst: false });
  });

  it("prefills a demo account's name within those limits", async () => {
    routeVersion(
      { ui_spec_yaml: "instances: multiple\nfields: []\n", resources_yaml: resources },
      "demo-user@demo.kubeport",
    );
    const el = await render("web-app");
    const name = el.props.defaultName as string;
    expect(name).toMatch(/^web-app-[a-z0-9]{4}$/);
    expect(name.length).toBeLessThanOrEqual(37);
  });
});
