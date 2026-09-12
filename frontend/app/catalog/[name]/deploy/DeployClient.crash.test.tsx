import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// A render failure nobody has found yet. The message stands in for whatever
// internal reason such a failure would carry.
vi.mock("@/components/DynamicForm", () => ({
  DynamicForm: () => {
    throw new Error("internal reason: schemaFromUISpec exploded");
  },
}));

const spec: UISpec = {
  fields: [{ path: "spec.replicas", label: "Replicas", type: "integer", default: 1 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CRASHED = /이 템플릿의 입력 폼을 그리지 못했습니다/;

// #188 — the deploy form had no error boundary, so a throw anywhere under
// DynamicForm turned the page a user deploys from into a blank screen.
describe("DeployClient when the form cannot render", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/clusters") return jsonResponse({ clusters: [{ name: "dev" }] });
        if (url.includes("/render")) return jsonResponse({ rendered_yaml: "" });
        if (url === "/api/v1/selfsubjectaccessreview") return jsonResponse({ allowed: true, reason: "" });
        return jsonResponse({}, 404);
      }),
    );
    // React logs the caught error; the throw is the point of these tests.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("says so in a sentence for users, without the internal reason, and keeps the page", async () => {
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    expect(await screen.findByText(CRASHED)).toBeInTheDocument();
    expect(screen.queryByText(/internal reason|schemaFromUISpec/)).toBeNull();
    expect(screen.getByLabelText("배포 이름")).toBeInTheDocument();
  });

  // This component re-renders on every keystroke. A boundary that resets when
  // its children change would clear the sentence, throw again, and loop.
  it("stays on that sentence while the rest of the page re-renders", async () => {
    const user = userEvent.setup();
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await screen.findByText(CRASHED);
    await user.type(screen.getByLabelText("배포 이름"), "my-app");
    expect(screen.getAllByText(CRASHED)).toHaveLength(1);
    expect(screen.getByLabelText("배포 이름")).toHaveValue("my-app");
  });
});
