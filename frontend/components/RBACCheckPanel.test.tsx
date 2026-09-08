import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { RBACCheckPanel } from "./RBACCheckPanel";

function okResponse(body: { allowed: boolean; reason?: string }): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function httpResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("RBACCheckPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows placeholder and does not fetch when cluster is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RBACCheckPanel cluster="" namespace="default" kinds={["Deployment"]} />);
    expect(
      screen.getByText("클러스터/네임스페이스를 입력하면 권한을 확인합니다."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows placeholder and does not fetch when namespace is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RBACCheckPanel cluster="dev" namespace="" kinds={["Deployment"]} />);
    expect(
      screen.getByText("클러스터/네임스페이스를 입력하면 권한을 확인합니다."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows placeholder and does not fetch when kinds is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RBACCheckPanel cluster="dev" namespace="default" kinds={[]} />);
    expect(
      screen.getByText("클러스터/네임스페이스를 입력하면 권한을 확인합니다."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows success message when all kinds are allowed", async () => {
    const fetchMock = vi.fn(async () => okResponse({ allowed: true, reason: "" }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment", "Service"]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows the check scope (verb · namespace) in the header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ allowed: true })));
    render(<RBACCheckPanel cluster="dev" namespace="team-a" kinds={["Deployment"]} />);
    expect(screen.getByText("create · team-a")).toBeInTheDocument();
  });

  it("renders a plain-language denied row (raw reason only as title) plus next step", async () => {
    const raw = 'deployments.apps is forbidden: User "u" cannot create resource';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { resource: string };
      if (body.resource === "deployments") {
        return okResponse({ allowed: true, reason: "" });
      }
      return okResponse({ allowed: false, reason: raw });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment", "Service"]}
      />,
    );
    const row = await screen.findByText("❌ Service: 권한이 거부되었습니다.");
    expect(row).toHaveAttribute("title", raw);
    expect(screen.queryByText(/is forbidden/)).not.toBeInTheDocument();
    expect(screen.getByText(/이 상태로는 배포가 실패합니다/)).toBeInTheDocument();
    // Deployment (allowed) should not be in the denied list.
    expect(screen.queryByText(/Deployment:/)).not.toBeInTheDocument();
    expect(screen.queryByText("모든 리소스 생성 권한 확인됨.")).not.toBeInTheDocument();
  });

  it("renders HTTP status sentence when server returns 403", async () => {
    const fetchMock = vi.fn(async () => httpResponse(403));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["Deployment"]} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("❌ Deployment: 권한 확인에 실패했습니다 (HTTP 403)."),
      ).toBeInTheDocument();
    });
  });

  it("renders the check-failed sentence, not the raw error, when fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["Deployment"]} />,
    );
    const row = await screen.findByText("❌ Deployment: 권한 확인에 실패했습니다 (HTTP 0).");
    expect(row).toHaveAttribute("title", "network down");
    expect(screen.queryByText(/Deployment: network down/)).not.toBeInTheDocument();
  });

  it("reports unknown kinds as not-checked instead of allowed, without fetching them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["TotallyMadeUpCRD"]} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/확인하지 못한 종류: TotallyMadeUpCRD/)).toBeInTheDocument();
    });
    expect(screen.queryByText("모든 리소스 생성 권한 확인됨.")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows all-allowed for checked kinds alongside the not-checked warning", async () => {
    const fetchMock = vi.fn(async () => okResponse({ allowed: true, reason: "" }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment", "TotallyMadeUpCRD", "OtherCRD"]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/확인하지 못한 종류: TotallyMadeUpCRD, OtherCRD/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rapid prop change — stale fetch result does not overwrite newer results", async () => {
    // Two deferred promises: the first (slow) call resolves only after the
    // second (fast) call has completed and its result has been committed.
    let resolveSlow: (value: Response) => void = () => {};
    const slowPromise = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      const body = JSON.parse(String(init?.body ?? "{}")) as { cluster: string };
      if (body.cluster === "slow-cluster") {
        // Returns denied, but only after `fast-cluster` is resolved below.
        return slowPromise;
      }
      return Promise.resolve(okResponse({ allowed: true, reason: "" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <RBACCheckPanel
        cluster="slow-cluster"
        namespace="default"
        kinds={["Deployment"]}
      />,
    );

    // Rerender with new cluster BEFORE the slow fetch resolves. This should
    // flip `active = false` for the first effect run, so even when slowPromise
    // resolves with `denied`, setResults should NOT be called.
    rerender(
      <RBACCheckPanel
        cluster="fast-cluster"
        namespace="default"
        kinds={["Deployment"]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
    });

    // Now resolve the stale call with a denial. UI must stay on success state.
    resolveSlow(okResponse({ allowed: false, reason: "stale denial" }));

    // Give React a tick to process the resolved promise (if it were wrongly committed).
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
    expect(screen.queryByText(/stale denial/)).not.toBeInTheDocument();
  });
});
