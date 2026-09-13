import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import type { ErrorDetailLevel } from "@/lib/error-detail";
import { useKubeTermsStore } from "@/stores/kube-terms-store";
import { ErrorDetailProvider } from "./ErrorDetailProvider";
import { RBACCheckPanel } from "./RBACCheckPanel";

// #6: at "raw" the apiserver's reason sits under a denied row even with plain
// terms. The reason itself is decided by the server — a non-demo admin gets it
// (#102), everyone else an empty string — so this is presentation only.
const reason = 'RBAC: no rule for services in namespace "default"';

function okResponse(body: { allowed: boolean; reason?: string }): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function renderAt(level: ErrorDetailLevel, serverReason: string) {
  vi.stubGlobal("fetch", vi.fn(async () => okResponse({ allowed: false, reason: serverReason })));
  return render(
    <ErrorDetailProvider initial={level}>
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["Service"]} />
    </ErrorDetailProvider>,
  );
}

describe("RBACCheckPanel error detail level", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the reason inline at raw with plain terms", async () => {
    renderAt("raw", reason);
    expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it("keeps it to the hover title at friendly and detailed with plain terms", async () => {
    for (const level of ["friendly", "detailed"] as const) {
      const { unmount } = renderAt(level, reason);
      const row = await screen.findByText("내부 주소 — 만들 권한이 없습니다.");
      expect(row.closest("li")).toHaveAttribute("title", reason);
      expect(screen.queryByText(reason)).toBeNull();
      unmount();
    }
  });

  it("shows nothing extra at raw when the server sent no reason", async () => {
    renderAt("raw", "");
    const row = await screen.findByText("내부 주소 — 만들 권한이 없습니다.");
    expect(row.closest("li")).not.toHaveAttribute("title");
    expect(row.closest("li")?.querySelector(".font-mono")).toBeNull();
  });
});
