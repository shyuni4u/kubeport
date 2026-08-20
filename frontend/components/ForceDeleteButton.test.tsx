import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { ForceDeleteButton } from "./ForceDeleteButton";

// router.push / router.refresh are spy-able by mocking next/navigation.
const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

describe("ForceDeleteButton", () => {
  const fetchMock = vi.fn();
  const confirmMock = vi.fn();

  beforeEach(() => {
    pushMock.mockReset();
    refreshMock.mockReset();
    fetchMock.mockReset();
    confirmMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call fetch if confirm is cancelled", async () => {
    confirmMock.mockReturnValue(false);
    render(<ForceDeleteButton releaseId="rel-1" />);
    fireEvent.click(screen.getByRole("button", { name: "강제 삭제" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("calls DELETE /api/v1/releases/<id>?force=true and redirects on success", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ deleted: true, force: true }), {
        status: 200,
      }),
    );

    render(<ForceDeleteButton releaseId="rel-1" />);
    fireEvent.click(screen.getByRole("button", { name: "강제 삭제" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/releases/rel-1?force=true",
        { method: "DELETE" },
      );
    });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/releases");
    });
    // refresh() is intentionally NOT called — push() handles RSC fetch on
    // the destination route. Calling refresh() before navigation completes
    // would refresh the about-to-unmount /releases/<id> route, which is
    // wasted work.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("shows error message on failed response and re-enables the button", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue(
      new Response("forbidden: not admin", {
        status: 403,
        statusText: "Forbidden",
      }),
    );

    render(<ForceDeleteButton releaseId="rel-1" />);
    const btn = screen.getByRole("button", { name: "강제 삭제" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/forbidden: not admin/)).toBeInTheDocument();
    });
    // No redirect on failure.
    expect(pushMock).not.toHaveBeenCalled();
    // Button must be re-enabled so user can retry / leave.
    expect(btn).not.toBeDisabled();
  });
});
