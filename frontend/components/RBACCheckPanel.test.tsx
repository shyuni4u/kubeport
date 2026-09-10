import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, cleanup } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { RBACCheckPanel } from "./RBACCheckPanel";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

const HINT = "클러스터와 구역을 정하면 여기에 만들 수 있는지 확인합니다.";
const ALL_ALLOWED = "위 목록을 모두 만들 수 있습니다.";

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
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
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
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows placeholder and does not fetch when namespace is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RBACCheckPanel cluster="dev" namespace="" kinds={["Deployment"]} />);
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows placeholder and does not fetch when kinds is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RBACCheckPanel cluster="dev" namespace="default" kinds={[]} />);
    expect(screen.getByText(HINT)).toBeInTheDocument();
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
      expect(screen.getByText(ALL_ALLOWED)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // #39 — "create · team-a" was the one line of the panel still in k8s words.
  it("shows the check scope in plain words in the header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ allowed: true })));
    render(<RBACCheckPanel cluster="dev" namespace="team-a" kinds={["Deployment"]} />);
    expect(screen.getByText("team-a 구역에 만들기")).toBeInTheDocument();
    expect(screen.queryByText("create · team-a")).not.toBeInTheDocument();
  });

  // "내부 주소: 권한이 거부되었습니다" read as a blocked connection; the row
  // has to say it is creating that thing that is not allowed.
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
    // The icon is a lucide <svg> sibling since #114, so the sentence is its
    // own element and the admin-only raw reason stays on the <li>.
    const row = await screen.findByText("내부 주소 — 만들 권한이 없습니다.");
    expect(row.closest("li")).toHaveAttribute("title", raw);
    expect(screen.queryByText(/is forbidden/)).not.toBeInTheDocument();
    expect(screen.getByText(/이 상태로는 배포가 실패합니다/)).toBeInTheDocument();
    // Deployment (allowed) should not be in the denied list.
    expect(screen.queryByText(/^앱 —/)).not.toBeInTheDocument();
    expect(screen.queryByText(ALL_ALLOWED)).not.toBeInTheDocument();
  });

  it("renders HTTP status sentence when server returns 403", async () => {
    const fetchMock = vi.fn(async () => httpResponse(403));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["Deployment"]} />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("앱 — 권한 확인에 실패했습니다 (HTTP 403)."),
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
    const row = await screen.findByText(
      "앱 — 권한 확인에 실패했습니다 (HTTP 0).",
    );
    expect(row.closest("li")).toHaveAttribute("title", "network down");
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });

  it("reports unknown kinds as not-checked instead of allowed, without fetching them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RBACCheckPanel cluster="dev" namespace="default" kinds={["TotallyMadeUpCRD"]} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/확인하지 못한 항목: TotallyMadeUpCRD/)).toBeInTheDocument();
    });
    expect(screen.queryByText(ALL_ALLOWED)).not.toBeInTheDocument();
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
      expect(screen.getByText(ALL_ALLOWED)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/확인하지 못한 항목: TotallyMadeUpCRD, OtherCRD/),
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
      expect(screen.getByText(ALL_ALLOWED)).toBeInTheDocument();
    });

    // Now resolve the stale call with a denial. UI must stay on success state.
    resolveSlow(okResponse({ allowed: false, reason: "stale denial" }));

    // Give React a tick to process the resolved promise (if it were wrongly committed).
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText(ALL_ALLOWED)).toBeInTheDocument();
    expect(screen.queryByText(/stale denial/)).not.toBeInTheDocument();
  });
});

// #39 — an admin who turns raw terms on fixes RoleBindings with what the review
// asked k8s: the verb, group/resource, and k8s's own reason.
describe("RBACCheckPanel with raw k8s terms on", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useKubeTermsStore.setState({ showKubeTerms: true, touched: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the raw verb and namespace in the header", () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ allowed: true })));
    render(<RBACCheckPanel cluster="dev" namespace="team-a" kinds={["Deployment"]} />);
    expect(screen.getByText("create · team-a")).toBeInTheDocument();
  });

  it("names the denied review as verb and group/resource, with k8s's reason visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ allowed: false, reason: "RBAC: no rule for deployments.apps" })),
    );
    render(<RBACCheckPanel cluster="dev" namespace="default" kinds={["Deployment"]} />);
    expect(
      await screen.findByText("create apps/deployments — 만들 권한이 없습니다."),
    ).toBeInTheDocument();
    expect(screen.getByText("RBAC: no rule for deployments.apps")).toBeInTheDocument();
  });

  it("leaves the group out for a core resource", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ allowed: false, reason: "" })));
    render(<RBACCheckPanel cluster="dev" namespace="default" kinds={["Service"]} />);
    expect(await screen.findByText("create services — 만들 권한이 없습니다.")).toBeInTheDocument();
  });
});

// #30 — the deploy form disables its submit button when k8s definitively
// denies a create. The panel is the only place that knows, so it reports
// upwards. "denied" must mean *k8s said no*, never "we could not ask".
describe("RBACCheckPanel onResult", () => {
  beforeEach(() => {
    vi.useRealTimers();
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports 'unknown' while inputs are missing", () => {
    vi.stubGlobal("fetch", vi.fn());
    const onResult = vi.fn();
    render(
      <RBACCheckPanel
        cluster=""
        namespace="default"
        kinds={["Deployment"]}
        onResult={onResult}
      />,
    );
    expect(onResult).toHaveBeenLastCalledWith("unknown");
  });

  it("reports 'allowed' when every checked kind is allowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ allowed: true })),
    );
    const onResult = vi.fn();
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment", "Service"]}
        onResult={onResult}
      />,
    );
    await waitFor(() => {
      expect(onResult).toHaveBeenLastCalledWith("allowed");
    });
  });

  it("reports 'denied' when k8s denies a kind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ allowed: false, reason: "nope" })),
    );
    const onResult = vi.fn();
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment"]}
        onResult={onResult}
      />,
    );
    await waitFor(() => {
      expect(onResult).toHaveBeenLastCalledWith("denied");
    });
  });

  // A failed check is not a denial. Blocking on it would strand users behind
  // an unrelated outage; the panel already shows its own "check failed" line.
  it("reports 'unknown' when the check itself fails (HTTP error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(httpResponse(500)));
    const onResult = vi.fn();
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["Deployment"]}
        onResult={onResult}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    });
    expect(onResult).toHaveBeenLastCalledWith("unknown");
  });

  // Unmapped kinds already surface as an amber warning. They are not a
  // denial, so they must not block the button either.
  it("reports 'unknown' when the only kind is unmapped", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onResult = vi.fn();
    render(
      <RBACCheckPanel
        cluster="dev"
        namespace="default"
        kinds={["WeirdCRD"]}
        onResult={onResult}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/WeirdCRD/)).toBeInTheDocument();
    });
    expect(onResult).toHaveBeenLastCalledWith("unknown");
  });
});
