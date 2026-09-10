import { Profiler, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { RBACCheckPanel, type RbacStatus } from "./RBACCheckPanel";

function okResponse(body: { allowed: boolean; reason?: string }): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * #99 — the panel reported its verdict from an effect, which runs after the
 * commit that rendered it. So there was one commit in which the panel already
 * said "권한이 거부되었습니다" and the deploy form, not yet told, left its
 * button enabled.
 *
 * A test that waits for the sentence and then checks the button cannot see
 * that commit reliably — #95's CI caught it once, by timing. This records every
 * commit instead: a Profiler's onRender runs during the commit, after the DOM
 * is updated, so it reads what the panel shows and what the parent holds as of
 * the same commit. The parent writes its verdict into the DOM so both come from
 * one snapshot.
 */
describe("RBACCheckPanel verdict timing", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hands the parent a denial in the same commit that first shows it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ allowed: false, reason: "nope" })),
    );

    const commits: Array<{ verdict: string; deniedShown: boolean }> = [];
    const record = () => {
      commits.push({
        verdict: document.querySelector("[data-testid=verdict]")?.textContent ?? "",
        deniedShown: document.body.textContent?.includes("권한이 거부되었습니다") ?? false,
      });
    };

    function Form() {
      const [verdict, setVerdict] = useState<RbacStatus>("unknown");
      return (
        <Profiler id="deploy-form" onRender={record}>
          <output data-testid="verdict">{verdict}</output>
          <RBACCheckPanel
            cluster="dev"
            namespace="default"
            kinds={["Deployment"]}
            onResult={setVerdict}
          />
        </Profiler>
      );
    }

    render(<Form />);

    await waitFor(() => expect(commits.some((c) => c.deniedShown)).toBe(true));
    const shown = commits.filter((c) => c.deniedShown);
    expect(shown.map((c) => c.verdict)).toEqual(shown.map(() => "denied"));
  });
});
