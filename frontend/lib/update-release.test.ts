import { describe, it, expect, vi } from "vitest";

import { isReleaseId, readReleaseForUpdate, updateDeployPath } from "./update-release";

const ID = "3f2c1a9e-8b7d-4c6e-9f10-1a2b3c4d5e6f";

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Response;
}

const release = {
  id: ID,
  template: { name: "web-app", version: 2 },
  values_json: { "Secret[app].stringData.PASSWORD": "<redacted>" },
};

describe("isReleaseId", () => {
  it("accepts a UUID and nothing else", () => {
    expect(isReleaseId(ID)).toBe(true);
    expect(isReleaseId(ID.toUpperCase())).toBe(true);
    for (const bad of ["", "abc", `${ID}/../x`, `../templates/${ID}`, `${ID} `, ["a"], undefined]) {
      expect(isReleaseId(bad)).toBe(false);
    }
  });
});

// #296 — an update form rendered without the release's values fills its
// Secret fields from ui-spec defaults, and the PUT overwrites the running
// Secret with them.
describe("readReleaseForUpdate", () => {
  it("returns the release's template, version and values", async () => {
    const fetcher = vi.fn(async () => response(200, release));
    const read = await readReleaseForUpdate(fetcher, ID, "web-app");
    expect(fetcher).toHaveBeenCalledWith(`/v1/releases/${ID}`);
    expect(read).toEqual({
      kind: "ok",
      templateName: "web-app",
      version: 2,
      values: release.values_json,
    });
  });

  it("never asks the API about an id that is not one", async () => {
    const fetcher = vi.fn(async () => response(200, release));
    expect(await readReleaseForUpdate(fetcher, "../templates/x", "web-app")).toEqual({ kind: "not-found" });
    expect(await readReleaseForUpdate(fetcher, ["a", "b"], "web-app")).toEqual({ kind: "not-found" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads a missing, malformed or someone else's release as not found", async () => {
    for (const status of [400, 403, 404]) {
      const read = await readReleaseForUpdate(async () => response(status), ID, "web-app");
      expect(read).toEqual({ kind: "not-found" });
    }
  });

  it("sends an expired session to sign in", async () => {
    expect(await readReleaseForUpdate(async () => response(401), ID, "web-app")).toEqual({ kind: "sign-in" });
  });

  it("reports a server error, a rate limit or a network failure as unavailable, not as absent", async () => {
    for (const status of [500, 502, 503, 429]) {
      expect(await readReleaseForUpdate(async () => response(status), ID, "web-app")).toEqual({
        kind: "unavailable",
      });
    }
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await readReleaseForUpdate(offline, ID, "web-app")).toEqual({ kind: "unavailable" });
  });

  it("treats a body without values as unavailable rather than starting from defaults", async () => {
    for (const body of [
      undefined,
      {},
      { ...release, values_json: null },
      { ...release, values_json: [] },
      { ...release, template: { name: "web-app" } },
      { ...release, template: { name: "web-app", version: 0 } },
    ]) {
      expect(await readReleaseForUpdate(async () => response(200, body), ID, "web-app")).toEqual({
        kind: "unavailable",
      });
    }
  });

  it("refuses a release that belongs to another template", async () => {
    const read = await readReleaseForUpdate(async () => response(200, release), ID, "other-app");
    expect(read).toEqual({ kind: "not-found" });
  });

  it("matches a template name that reached the route still percent-encoded", async () => {
    const spaced = { ...release, template: { name: "web app", version: 2 } };
    const read = await readReleaseForUpdate(async () => response(200, spaced), ID, "web%20app");
    expect(read.kind).toBe("ok");
  });
});

describe("updateDeployPath", () => {
  it("encodes the template name and the id", () => {
    expect(updateDeployPath("a/b?c", 3, ID)).toBe(`/catalog/a%2Fb%3Fc/versions/3/deploy?updateReleaseId=${ID}`);
  });
});
