import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useTemplateYamlValidation } from "./useTemplateYamlValidation";

// The shape the cluster serves at /openapi/v3/apis/apps/v1: the kind's schema
// found by x-kubernetes-group-version-kind, its fields behind allOf/$ref.
const APPS_V1 = {
  components: {
    schemas: {
      "io.k8s.api.apps.v1.Deployment": {
        type: "object",
        "x-kubernetes-group-version-kind": [{ group: "apps", version: "v1", kind: "Deployment" }],
        properties: {
          spec: { allOf: [{ $ref: "#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec" }] },
        },
      },
      "io.k8s.api.apps.v1.DeploymentSpec": {
        type: "object",
        properties: { replicas: { type: "integer" } },
      },
    },
  },
};

const RESOURCES = 'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  replicas: "many"\n';

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("useTemplateYamlValidation", () => {
  it("loads the kind's schema from the remembered cluster and warns on a wrong type", async () => {
    window.sessionStorage.setItem("kbp:editor-cluster", "second");
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v1/clusters") return json({ clusters: [{ name: "first" }, { name: "second" }] });
      if (url === "/api/v1/clusters/second/openapi/apps/v1") return json(APPS_V1);
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTemplateYamlValidation(RESOURCES, ""));
    await waitFor(
      () => expect(result.current.resources.map((i) => i.code)).toEqual(["schemaType"]),
      { timeout: 3000 },
    );
    expect(result.current.resources[0]).toMatchObject({ severity: "warning", startLine: 5 });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/clusters/second/openapi/apps/v1");
  });

  it("still reports syntax errors when no cluster answers", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const { result } = renderHook(() => useTemplateYamlValidation("a: [1, 2\nb: 3\n", ""));
    await waitFor(() => expect(result.current.resources.map((i) => i.code)).toContain("unclosedFlow"));
  });

  it("never requests an apiVersion that is not a GroupVersion", async () => {
    const fetchMock = vi.fn((url: string) =>
      url === "/api/v1/clusters" ? json({ clusters: [{ name: "c" }] }) : json({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useTemplateYamlValidation("apiVersion: ../../v1\nkind: Secret\nmetadata: { name: x }\n", ""));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/clusters"));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
