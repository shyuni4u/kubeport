import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

const spec: UISpec = {
  fields: [
    {
      path: "spec.replicas",
      label: "Replicas",
      type: "integer",
      min: 1,
      max: 5,
      default: 1,
      required: true,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * The deploy form talks to four endpoints. Each test only cares about one or
 * two of them, so route by URL and let the rest answer with a benign default.
 */
function routedFetch(overrides: {
  ssar?: (body: Record<string, unknown>) => Response;
  releases?: () => Response;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/clusters") {
      return jsonResponse({ clusters: [{ name: "dev" }] });
    }
    if (url.includes("/render")) {
      return jsonResponse({
        rendered_yaml: "apiVersion: apps/v1\nkind: Deployment\n",
      });
    }
    if (url === "/api/v1/selfsubjectaccessreview") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return overrides.ssar
        ? overrides.ssar(body)
        : jsonResponse({ allowed: true, reason: "" });
    }
    if (url === "/api/v1/releases") {
      return overrides.releases
        ? overrides.releases()
        : jsonResponse({ id: "rel-1" }, 201);
    }
    return jsonResponse({}, 404);
  });
}

async function fillMeta(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("배포 이름"), "my-app");
}

describe("DeployClient", () => {
  beforeEach(() => {
    pushMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // #30 — a denied preflight used to leave the button an active indigo
  // primary, so users clicked into a guaranteed failure.
  it("blocks submission while RBAC reports a denial", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        ssar: () => jsonResponse({ allowed: false, reason: "forbidden" }),
      }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText(/권한이 거부되었습니다/)).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: /배포하기/ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(
        "권한이 없어 지금은 배포할 수 없습니다. '권한 확인' 안내를 확인한 뒤 관리자에게 요청하세요.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps submission enabled when RBAC allows everything", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch({}));

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
  });

  // A failed preflight is not a denial — the user must still be able to try.
  it("does not block submission when the RBAC check itself fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ ssar: () => jsonResponse({}, 500) }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
  });

  // #42 — the red failure notice survived every subsequent edit, so a user
  // who fixed the offending value still saw "배포에 실패했습니다".
  it("clears a previous failure when the user edits the metadata", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ releases: () => jsonResponse({ message: "boom" }, 502) }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: /배포하기/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/서버에서 문제가 발생해/);

    await user.type(screen.getByLabelText("구역"), "-demo");

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
