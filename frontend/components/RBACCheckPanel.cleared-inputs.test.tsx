import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { RBACCheckPanel } from "./RBACCheckPanel";

/**
 * Clearing the inputs while a check is still out used to leave the panel on
 * "확인 중…" with no hint: the cleanup rightly drops that check's result, but
 * that result was the only thing that ever set `loading` back to false. The
 * deploy form clears `kinds` whenever its preview render fails, so this is a
 * state the form reaches, not a contrived one.
 */
describe("RBACCheckPanel with inputs cleared mid-check", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("goes back to the hint instead of staying on 'checking'", () => {
    // Never settles: the check is still out when the inputs go away.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const { rerender } = render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["Deployment"]} />,
    );
    expect(screen.getByText("확인 중…")).toBeInTheDocument();

    rerender(<RBACCheckPanel cluster="dev" namespace="default" kinds={[]} />);

    expect(screen.queryByText("확인 중…")).not.toBeInTheDocument();
    expect(
      screen.getByText("클러스터와 구역을 정하면 여기에 만들 수 있는지 확인합니다."),
    ).toBeInTheDocument();
  });
});
