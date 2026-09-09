import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { ReleaseTable } from "./ReleaseTable";

const rows = [
  {
    id: "r1",
    name: "web-prod",
    template_name: "web",
    template_version: 1,
    namespace: "default",
  },
  {
    id: "r2",
    name: "web-staging",
    template_name: "web",
    template_version: 2,
    namespace: "staging",
  },
];

function statusResponse(status: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status }),
  } as unknown as Response;
}

/** Answers each `/api/v1/releases/{id}` probe from a per-id map. */
function statusFetch(byId: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const id = url.split("/").pop()!;
    const status = byId[id];
    if (!status) return { ok: false, status: 404 } as unknown as Response;
    return statusResponse(status);
  });
}

describe("ReleaseTable", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders empty-state message when no rows", () => {
    render(<ReleaseTable rows={[]} />);
    expect(screen.getByText("아직 배포된 릴리스가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a row per release without a status column", () => {
    vi.stubGlobal("fetch", statusFetch({}));
    render(<ReleaseTable rows={rows} />);
    const link1 = screen.getByRole("link", { name: /web-prod/ });
    expect(link1).toHaveAttribute("href", "/releases/r1");
    expect(screen.getByText("web@v1")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    // The 상태 column stays removed — the owner asked for it in Plan 6
    // ("목록에서 굳이 다 보여줘야하나"). Failures are marked inline instead.
    expect(screen.queryByText("상태")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  // A release that has been failing for hours used to look exactly like a
  // healthy one, so you had to open every row to find it.
  it("marks a release that is not healthy", async () => {
    vi.stubGlobal("fetch", statusFetch({ r1: "healthy", r2: "error" }));
    render(<ReleaseTable rows={rows} />);

    await waitFor(() => {
      expect(screen.getByText("오류")).toBeInTheDocument();
    });
    // …and only that one: a healthy row is left exactly as it was.
    expect(screen.queryByText("정상")).toBeNull();
  });

  it("marks cluster-unreachable and resources-missing too", async () => {
    vi.stubGlobal(
      "fetch",
      statusFetch({ r1: "cluster-unreachable", r2: "resources-missing" }),
    );
    render(<ReleaseTable rows={rows} />);

    await waitFor(() => {
      expect(screen.getByText("클러스터 응답 없음")).toBeInTheDocument();
    });
    expect(screen.getByText("리소스 없음")).toBeInTheDocument();
  });

  // "unknown" means we could not tell, not that something is wrong. Badging it
  // would put a chip on most rows and undo the point of the removal.
  it("does not mark unknown", async () => {
    const fetchMock = statusFetch({ r1: "unknown", r2: "unknown" });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReleaseTable rows={rows} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("알 수 없음")).toBeNull();
  });

  // The probe is an enhancement layered on a DB-only list. If it fails the
  // table must still be the table.
  it("still renders every row when the probe fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<ReleaseTable rows={rows} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: /web-prod/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /web-staging/ })).toBeInTheDocument();
  });

  it("probes each release exactly once", async () => {
    const fetchMock = statusFetch({ r1: "healthy", r2: "error" });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReleaseTable rows={rows} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map(([u]) => u).sort();
    expect(urls).toEqual(["/api/v1/releases/r1", "/api/v1/releases/r2"]);
  });
});
