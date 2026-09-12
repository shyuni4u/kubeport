import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { RBACCheckPanel } from "./RBACCheckPanel";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

// #248: a CRD can share a core kind's name — Knative's
// `serving.knative.dev/v1` Service is not a core Service. Checked by name
// alone it became an SSAR about core `services`, whose answer says nothing
// about the Knative object, and was shown under the core kind's friendly name.

function okResponse(body: { allowed: boolean; reason?: string }): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("RBACCheckPanel with apiVersions", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not check a CRD that shares a core kind's name, and names it by its kind", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={[{ apiVersion: "serving.knative.dev/v1", kind: "Service" }]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/확인하지 못한 항목: Service/)).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the core kind and skips its namesake in another group", async () => {
    const fetchMock = vi.fn(async () => okResponse({ allowed: true, reason: "" }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={[
          { apiVersion: "v1", kind: "Service" },
          { apiVersion: "serving.knative.dev/v1", kind: "Service" },
          { apiVersion: "apps/v1", kind: "Deployment" },
        ]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/확인하지 못한 항목: Service/)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const asked = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as { group: string; resource: string },
    );
    expect(asked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "", resource: "services" }),
        expect.objectContaining({ group: "apps", resource: "deployments" }),
      ]),
    );
  });
});
