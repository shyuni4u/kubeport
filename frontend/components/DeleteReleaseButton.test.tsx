import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { DeleteReleaseButton } from "./DeleteReleaseButton";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

describe("DeleteReleaseButton", () => {
  const fetchMock = vi.fn();
  const confirmMock = vi.fn();

  beforeEach(() => {
    pushMock.mockReset();
    fetchMock.mockReset();
    confirmMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", confirmMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for confirmation with the release name and does nothing when cancelled", () => {
    confirmMock.mockReturnValue(false);
    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("'my-app'"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("calls DELETE /api/v1/releases/<id> without ?force and redirects on success", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));

    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/releases/rel-1", { method: "DELETE" });
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/releases"));
  });

  it("shows the no-permission sentence on 403 and never the response body", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValue(
      new Response('releases.kubeport.io is forbidden: User "x" cannot delete', {
        status: 403,
      }),
    );

    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    const btn = screen.getByRole("button", { name: "삭제" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("이 릴리스를 삭제할 권한이 없습니다.");
    });
    expect(screen.queryByText(/is forbidden/)).not.toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
    expect(btn).not.toBeDisabled();
  });

  it("shows the generic sentence on other failures and on network errors", async () => {
    confirmMock.mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("삭제하지 못했습니다.");
    });
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("삭제하지 못했습니다.");
    });
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });
});
