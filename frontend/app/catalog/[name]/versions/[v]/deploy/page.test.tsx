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

// #296 (a)
describe("version-pinned deploy page, updating a release", () => {
  it("starts the form from the release's values", async () => {
    route(() => json(200, { template: { name: "web-app", version: 2 }, values_json: { [SECRET]: "<redacted>" } }));
    const el = await render(ID);
    expect(el.type).toBe(DeployClient);
    expect(el.props.updateReleaseId).toBe(ID);
    expect(el.props.initialValues).toEqual({ [SECRET]: "<redacted>" });
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
