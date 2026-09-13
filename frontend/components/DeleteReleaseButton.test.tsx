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

  // The button asks for the storage verdict (GET ...?include=storage_on_delete)
  // before confirming, then DELETEs. storage answers the first, del the second.
  function answer({
    storage = { storage_on_delete: "none" } as unknown,
    storageStatus = 200,
    del = () => new Response(JSON.stringify({ deleted: true }), { status: 200 }),
  }: {
    storage?: unknown;
    storageStatus?: number;
    del?: () => Response | Promise<Response>;
  } = {}) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(del());
      return Promise.resolve(new Response(JSON.stringify(storage), { status: storageStatus }));
    });
  }

  const deleteCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");

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

  it("asks for confirmation with the release name and does nothing when cancelled", async () => {
    answer();
    confirmMock.mockReturnValue(false);
    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    const btn = screen.getByRole("button", { name: "삭제" });
    fireEvent.click(btn);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("'my-app'")));
    expect(confirmMock).toHaveBeenCalledWith(expect.not.stringContaining("저장소"));
    expect(deleteCalls()).toHaveLength(0);
    expect(pushMock).not.toHaveBeenCalled();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  // #340: deleting a release's storage cannot be undone, so the reader hears
  // it before confirming — asked of the cluster as the confirmation opens.
  it("asks what the delete does to storage, with the opt-in query", async () => {
    answer();
    confirmMock.mockReturnValue(false);
    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/releases/rel-1?include=storage_on_delete"));
  });

  it.each([
    ["deleted", "저장소(데이터)도 함께 삭제됩니다"],
    ["kept", "클러스터에 남습니다"],
    ["unknown", "함께 삭제될 수 있습니다"],
  ])("says what happens to storage when it is %s", async (verdict, sentence) => {
    answer({ storage: { storage_on_delete: verdict } });
    confirmMock.mockReturnValue(false);
    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining(sentence)));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("'my-app'"));
  });

  it("warns that storage may be deleted when the verdict cannot be fetched", async () => {
    answer({ storage: "boom", storageStatus: 502 });
    confirmMock.mockReturnValue(false);
    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("함께 삭제될 수 있습니다")));
  });

  it("calls DELETE /api/v1/releases/<id> without ?force and redirects on success", async () => {
    answer();
    confirmMock.mockReturnValue(true);

    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/releases/rel-1", { method: "DELETE" });
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/releases"));
  });

  it("shows the no-permission sentence on 403 and never the response body", async () => {
    answer({
      del: () => new Response('releases.kubeport.io is forbidden: User "x" cannot delete', { status: 403 }),
    });
    confirmMock.mockReturnValue(true);

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
    answer({ del: () => new Response("boom", { status: 500 }) });
    confirmMock.mockReturnValue(true);

    render(<DeleteReleaseButton releaseId="rel-1" name="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("삭제하지 못했습니다.");
    });
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();

    answer({ del: () => Promise.reject(new Error("network down")) });
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("삭제하지 못했습니다.");
    });
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });
});
