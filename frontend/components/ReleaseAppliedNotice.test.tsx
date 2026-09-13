import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

const replaceMock = vi.fn();
let search = "";
let pathname = "/releases/rel-1";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => pathname,
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), refresh: vi.fn() }),
}));

import { ReleaseAppliedNotice } from "./ReleaseAppliedNotice";

beforeEach(() => {
  replaceMock.mockReset();
  search = "";
  pathname = "/releases/rel-1";
});

// #362: the update form sent the reader back to the release and said nothing,
// so the arrival screen looked like the one they had left and the natural
// move was to submit the same form again.
describe("ReleaseAppliedNotice", () => {
  it("says the update was applied and that the status may change for a moment", () => {
    search = "applied=1";
    render(<ReleaseAppliedNotice />);

    expect(screen.getByText("바뀐 설정을 적용했습니다.")).toBeInTheDocument();
    expect(screen.getByText(/상태가 잠시 바뀔 수 있습니다/)).toBeInTheDocument();
  });

  // A status region that appears together with its text is often not read
  // out. The region is there, empty, from the first render, and the sentence
  // arrives in it afterwards — a change screen readers do announce.
  it("fills an already-present live region after mount, so it is announced", async () => {
    search = "applied=1";
    render(<ReleaseAppliedNotice />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();

    await waitFor(() => expect(region).toHaveTextContent("바뀐 설정을 적용했습니다."));
    expect(region).toHaveTextContent("상태가 잠시 바뀔 수 있습니다");
  });

  // Once: a reload, a shared link or going back must not announce it again.
  it("takes the query off the URL, keeping any other parameters", () => {
    search = "applied=1";
    render(<ReleaseAppliedNotice />);
    expect(replaceMock).toHaveBeenCalledWith("/releases/rel-1", { scroll: false });

    replaceMock.mockReset();
    search = "applied=1&instance=web-1";
    pathname = "/releases/rel-1/logs";
    render(<ReleaseAppliedNotice />);
    expect(replaceMock).toHaveBeenCalledWith("/releases/rel-1/logs?instance=web-1", { scroll: false });
  });

  it("stays visible after the query is gone, until dismissed", () => {
    search = "applied=1";
    const { rerender } = render(<ReleaseAppliedNotice />);

    search = ""; // what router.replace leads to
    rerender(<ReleaseAppliedNotice />);
    expect(screen.getByText("바뀐 설정을 적용했습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("button", { name: "닫기" })).toBeNull();
  });

  it("shows nothing, announces nothing and leaves the URL alone on a plain visit", async () => {
    render(<ReleaseAppliedNotice />);

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("바뀐 설정을 적용했습니다.")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("ignores a value other than 1", () => {
    search = "applied=yes";
    render(<ReleaseAppliedNotice />);

    expect(screen.queryByText("바뀐 설정을 적용했습니다.")).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
