import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// notFound() and redirect() throw to unwind the render; the mocks throw a
// recognisable value so a test can see which one ran.
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

import VersionPinnedDeployPage from "./page";
import { DeployClient } from "../../../deploy/DeployClient";
import { UpdateValuesUnavailable } from "@/components/UpdateValuesUnavailable";

const ID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";
const SECRET = "Secret[app].stringData.PASSWORD";

function json(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function route(release: () => Response) {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/v1/templates/web-app/versions/2") {
      return json(200, {
        ui_spec_yaml: `fields:\n  - path: "${SECRET}"\n    label: Password\n    type: string\n    default: changeme\n`,
        owning_team_name: null,
      });
    }
    if (path === `/v1/releases/${ID}`) return release();
    if (path === "/v1/me") return json(200, { email: "someone@example.com" });
    return json(404);
  });
}

function render(updateReleaseId?: string) {
  return VersionPinnedDeployPage({
    params: Promise.resolve({ name: "web-app", v: "2" }),
    searchParams: Promise.resolve(updateReleaseId === undefined ? {} : { updateReleaseId }),
  }) as Promise<ReactElement<Record<string, unknown>>>;
}

beforeEach(() => apiFetch.mockReset());

// #374 — the name param arrives decoded; a `/` or `..` in it would put the
// page's API calls on another /v1 route.
describe("version-pinned deploy page, the name in API paths", () => {
  function renderNamed(name: string, updateReleaseId?: string) {
    return VersionPinnedDeployPage({
      params: Promise.resolve({ name, v: "2" }),
      searchParams: Promise.resolve(updateReleaseId === undefined ? {} : { updateReleaseId }),
    }) as Promise<ReactElement<Record<string, unknown>>>;
  }

  it.each(["..", "a/b", `../releases/${ID}`, "a\\b"])(
    "refuses %j before asking the API",
    async (name) => {
      apiFetch.mockResolvedValue(json(200, {}));
      await expect(renderNamed(name)).rejects.toThrow("NOT_FOUND");
      await expect(renderNamed(name, ID)).rejects.toThrow("NOT_FOUND");
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  // #375 keeps names from before its rule working.
  it.each([
    ["WebApp", "/v1/templates/WebApp/versions/2"],
    ["web app", "/v1/templates/web%20app/versions/2"],
  ])("still asks for a template named %j, as one encoded segment", async (name, path) => {
    apiFetch.mockResolvedValue(json(404));
    await expect(renderNamed(name)).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).toHaveBeenCalledWith(path);
  });
});

// #296 (a)
describe("version-pinned deploy page, updating a release", () => {
  it("starts the form from the release's values", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 }, values_json: { [SECRET]: "<redacted>" } }));
    const el = await render(ID);
    expect(el.type).toBe(DeployClient);
    expect(el.props.updateReleaseId).toBe(ID);
    expect(el.props.initialValues).toEqual({ [SECRET]: "<redacted>" });
  });

  // #359 — the form names the release it changes, and says "change settings"
  // rather than "update to v2" when the version stays the same.
  it("tells the form which release it is changing, and its version", async () => {
    route(() =>
      json(200, { name: "hello-web", template: { name: "web-app", version: 2 }, values_json: {} }),
    );
    const el = await render(ID);
    expect(el.props.updateRelease).toEqual({ name: "hello-web", version: 2 });
  });

  it("does not render an update form when the release's values could not be read", async () => {
    route(() => json(503));
    const el = await render(ID);
    expect(el.type).toBe(UpdateValuesUnavailable);
    expect(el.props).toEqual({ releaseId: ID });
  });

  it("does not render an update form for a release body with no values", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 } }));
    expect((await render(ID)).type).toBe(UpdateValuesUnavailable);
  });

  it("shows not found for a release that is gone, not yours, or another template's", async () => {
    route(() => json(404));
    await expect(render(ID)).rejects.toThrow("NOT_FOUND");
    route(() => json(200, { template: { name: "other-app", version: 2 }, values_json: {} }));
    await expect(render(ID)).rejects.toThrow("NOT_FOUND");
  });

  it("shows not found for an id that is not one, without asking the API", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 }, values_json: {} }));
    await expect(render("../templates/x")).rejects.toThrow("NOT_FOUND");
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/v1/releases/"));
  });

  it("sends an expired session to sign in and back to this form", async () => {
    route(() => json(401));
    await expect(render(ID)).rejects.toThrow(
      `REDIRECT /?next=${encodeURIComponent(`/catalog/web-app/versions/2/deploy?updateReleaseId=${ID}`)}`,
    );
  });

  it("still renders a new-release form without an update id", async () => {
    route(() => json(500));
    const el = await render();
    expect(el.type).toBe(DeployClient);
    expect(el.props.updateReleaseId).toBeUndefined();
  });
});

// #190 — the pinned version's objects decide what a new release's name may be.
describe("version-pinned deploy page, name rules", () => {
  const resources = "kind: Service\nmetadata:\n  name: web\n---\nkind: CronJob\nmetadata:\n  name: nightly-backup\n";

  function routeVersion(uiSpec: string, email: string, release?: () => Response) {
    apiFetch.mockImplementation(async (path) => {
      if (path === "/v1/templates/web-app/versions/2") {
        return json(200, { ui_spec_yaml: uiSpec, resources_yaml: resources, owning_team_name: null });
      }
      if (path === `/v1/releases/${ID}` && release) return release();
      if (path === "/v1/me") return json(200, { email });
      return json(404);
    });
  }

  it("hands a new release's form the multi-instance version's limits and a demo name within them", async () => {
    routeVersion("instances: multiple\nfields: []\n", "demo-user@demo.kubeport");
    const el = await render();
    expect(el.props.nameRules).toEqual({ multiple: true, maxLength: 37, letterFirst: true });
    const name = el.props.defaultName as string;
    expect(name).toMatch(/^web-app-[a-z0-9]{4}$/);
    expect(name.length).toBeLessThanOrEqual(37);
  });

  it("keeps a single-instance version's rules", async () => {
    routeVersion("fields: []\n", "someone@example.com");
    const el = await render();
    expect(el.props.nameRules).toEqual({ multiple: false, maxLength: 63, letterFirst: false });
    expect(el.props.defaultName).toBe("");
  });

  it("prefills no name for an update, which keeps the one it has", async () => {
    routeVersion("instances: multiple\nfields: []\n", "demo-user@demo.kubeport", () =>
      json(200, { template: { name: "web-app", version: 2 }, values_json: {} }),
    );
    const el = await render(ID);
    expect(el.type).toBe(DeployClient);
    expect(el.props.defaultName).toBe("");
  });
});
