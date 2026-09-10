import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import {
  ReleaseAutoRefresh,
  REFRESH_DELAYS_MS,
  REFRESH_GIVE_UP_MS,
} from "./ReleaseAutoRefresh";

// #183 — the release detail page was rendered once and never again: a release
// deployed a moment ago read "대기 중 · 0/1" until the reader reloaded, while
// the API had been answering `healthy` for over a minute.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  visibility = "visible";
});

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ReleaseAutoRefresh", () => {
  it("re-reads a release that is still settling, backing off between reads", () => {
    render(<ReleaseAutoRefresh status="warning" />);

    wait(REFRESH_DELAYS_MS[0] - 1);
    expect(refresh).not.toHaveBeenCalled();
    wait(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The second read waits the longer delay, not the first one again.
    wait(REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
    wait(REFRESH_DELAYS_MS[1] - REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("treats a release with no pods yet as settling too", () => {
    render(<ReleaseAutoRefresh status="unknown" />);

    wait(REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves settled and stale releases alone", () => {
    for (const status of ["healthy", "error", "cluster-unreachable", "resources-missing"]) {
      const view = render(<ReleaseAutoRefresh status={status} />);
      wait(REFRESH_GIVE_UP_MS);
      view.unmount();
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  // The refresh re-renders the layout with the new status; that is what has
  // to end the polling.
  it("stops once a refresh brings a settled status", () => {
    const view = render(<ReleaseAutoRefresh status="warning" />);
    wait(REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(1);

    view.rerender(<ReleaseAutoRefresh status="healthy" />);
    wait(REFRESH_GIVE_UP_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips reads while the tab is hidden, and resumes when it is shown", () => {
    render(<ReleaseAutoRefresh status="warning" />);
    visibility = "hidden";

    wait(REFRESH_DELAYS_MS[0] + REFRESH_DELAYS_MS[1]);
    expect(refresh).not.toHaveBeenCalled();

    visibility = "visible";
    wait(REFRESH_DELAYS_MS[2]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // A CronJob between runs has no pods and stays `unknown` for good.
  it("gives up after a while instead of polling forever", () => {
    render(<ReleaseAutoRefresh status="unknown" />);

    wait(REFRESH_GIVE_UP_MS);
    const calls = refresh.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    wait(REFRESH_GIVE_UP_MS);
    // At most the one read already scheduled when the limit passed.
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it("stops polling when the page goes away", () => {
    const view = render(<ReleaseAutoRefresh status="warning" />);
    view.unmount();

    wait(REFRESH_GIVE_UP_MS);
    expect(refresh).not.toHaveBeenCalled();
  });
});
