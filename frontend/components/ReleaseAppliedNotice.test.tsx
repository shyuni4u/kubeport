import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("바뀐 설정을 적용했습니다");
    expect(notice).toHaveTextContent("상태가 잠시 바뀔 수 있습니다");
  });

  // Once: a reload, a shared link or going back must not announce it again.
  it("takes the query off the URL, keeping any other parameters", () => {
    search = "applied=1";
    render(<ReleaseAppliedNotice />);
    expect(replaceMock).toHaveBeenCalledWith("/releases/rel-1", { scroll: false });

    replaceMock.mockReset();
    search = "applied=1&tab=x";
    pathname = "/releases/rel-1/logs";
    render(<ReleaseAppliedNotice />);
    expect(replaceMock).toHaveBeenCalledWith("/releases/rel-1/logs?tab=x", { scroll: false });
  });

  it("stays visible after the query is gone, until dismissed", () => {
    search = "applied=1";
    const { rerender } = render(<ReleaseAppliedNotice />);

    search = ""; // what router.replace leads to
    rerender(<ReleaseAppliedNotice />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing and leaves the URL alone on a plain visit", () => {
    render(<ReleaseAppliedNotice />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("ignores a value other than 1", () => {
    search = "applied=yes";
    render(<ReleaseAppliedNotice />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
