import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ClusterWorkspace } from "./ClusterWorkspace";
import { ErrorDetailProvider } from "./ErrorDetailProvider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
const snapshot = {
  permissions: { "create-pvc": true },
  sections: [
    {
      resource: "storageclasses",
      items: [
        {
          kind: "StorageClass",
          name: "fast",
          status: "csi",
          details: [],
          foundation: { namespace: "team", max_gi: 10 },
        },
        {
          kind: "StorageClass",
          name: "private",
          status: "csi",
          details: [],
          foundation: { namespace: "other", max_gi: 10 },
        },
      ],
    },
  ],
};
describe("cluster operations", () => {
  it("offers only the namespace foundation and requires review before writing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ accepted: true });
      return Response.json(
        url === "/api/v1/clusters"
          ? { clusters: [{ name: "prod", default_namespace: "team" }] }
          : snapshot,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ErrorDetailProvider initial="raw">
        <ClusterWorkspace area="storage" admin={false} demo={false} />
      </ErrorDetailProvider>,
    );
    await screen.findByRole("option", { name: "fast" });
    expect(
      screen.queryByRole("option", { name: "private" }),
    ).not.toBeInTheDocument();
    const form = screen
      .getByRole("heading", { name: "스토리지 만들기 (PVC)" })
      .closest("form")!;
    fireEvent.change(within(form).getByLabelText("StorageClass"), {
      target: { value: "fast" },
    });
    fireEvent.change(within(form).getByLabelText("PVC 이름"), {
      target: { value: "data" },
    });
    await waitFor(() => expect(within(form).getByRole("button")).toBeEnabled());
    fireEvent.submit(form);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "변경 실행" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1),
    );
    const [url, init] = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )!;
    expect(url).toBe("/api/v1/clusters/prod/operations");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      action: "create-pvc",
      namespace: "team",
      class: "fast",
      name: "data",
      size_gi: 1,
    });
  });
  it("explains demo restrictions without requesting infrastructure", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ clusters: [{ name: "prod" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ErrorDetailProvider initial="friendly">
        <ClusterWorkspace area="nodes" admin demo />
      </ErrorDetailProvider>,
    );
    await screen.findByRole("option", { name: "prod" });
    expect(screen.getByRole("status")).toHaveTextContent("공개 데모 계정");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "새로고침" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "노드 운영 beta" })).toHaveAttribute("href", "/clusters/prod/nodes");
    expect(screen.getByRole("link", { name: "스토리지 beta" })).toHaveAttribute("href", "/clusters/prod/storage");
  });

  it("keeps the URL cluster when switching tools, instead of the globally selected cluster", async () => {
    localStorage.setItem("kbp_cluster", "other");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ clusters: [{ name: "other" }, { name: "prod" }] })));
    render(<ErrorDetailProvider initial="friendly"><ClusterWorkspace area="storage" initialCluster="prod" admin={false} demo /></ErrorDetailProvider>);
    await screen.findByRole("option", { name: "prod" });
    expect(screen.getByRole("link", { name: "네트워크 · 라우팅 beta" })).toHaveAttribute("href", "/clusters/prod/network");
    expect(screen.queryByRole("link", { name: "노드 운영 beta" })).not.toBeInTheDocument();
  });

  it("does not silently operate on another cluster when a bookmarked cluster disappears", async () => {
    const fetchMock = vi.fn(async () => Response.json({ clusters: [{ name: "other" }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ErrorDetailProvider initial="friendly"><ClusterWorkspace area="storage" initialCluster="missing" admin demo={false} /></ErrorDetailProvider>);
    await screen.findByText(/이 클러스터를 찾을 수 없거나/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

// The node screen lists pods from every namespace but has no namespace field,
// so a single screen-wide decision disabled eviction where it was allowed and
// enabled it where it was refused (#437).
const nodesSnapshot = {
  permissions: { cordon: true, evict: true },
  sections: [
    {
      resource: "nodes",
      items: [{ kind: "Node", name: "node-a", status: "Ready", details: [] }],
    },
    {
      resource: "pods",
      items: [
        {
          kind: "Pod",
          name: "allowed-pod",
          namespace: "beta",
          status: "Running",
          details: ["node: node-a", "eviction: PDB checked by Eviction API"],
          evictable: true,
        },
        {
          kind: "Pod",
          name: "refused-pod",
          namespace: "alpha",
          status: "Running",
          details: ["node: node-a", "eviction: PDB checked by Eviction API"],
          evictable: false,
        },
        {
          kind: "Pod",
          name: "unknown-pod",
          namespace: "gamma",
          status: "Running",
          details: ["node: node-a", "eviction: PDB checked by Eviction API"],
        },
      ],
    },
  ],
};

function renderNodes() {
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(
      url === "/api/v1/clusters"
        ? { clusters: [{ name: "prod", default_namespace: "team" }] }
        : nodesSnapshot,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ErrorDetailProvider initial="raw">
      <ClusterWorkspace area="nodes" admin={true} demo={false} />
    </ErrorDetailProvider>,
  );
  return fetchMock;
}

// The heading reads "<namespace>/<name>" — eviction is decided per namespace,
// so the namespace is part of how a pod is identified on screen.
const cardFor = (pod: string) => screen.getByText(pod).closest("li")!;
const evictButtonFor = (pod: string) =>
  within(cardFor(pod)).getByRole("button", {
    name: "Pod 이동 요청 (Eviction)",
  });

describe("node operations eviction", () => {
  it("disables eviction only for the pods whose own namespace refused it", async () => {
    renderNodes();
    await screen.findByText("alpha/refused-pod");
    expect(evictButtonFor("alpha/refused-pod")).toBeDisabled();
    expect(evictButtonFor("beta/allowed-pod")).toBeEnabled();
    // Unanswered is not a refusal: Kubernetes RBAC gives the real answer.
    expect(evictButtonFor("gamma/unknown-pod")).toBeEnabled();
  });

  it("explains a refusal instead of leaving the button silently off", async () => {
    renderNodes();
    await screen.findByText("alpha/refused-pod");
    const reason = "이 Pod 의 네임스페이스에서는 Pod 이동 권한이 없습니다.";
    expect(cardFor("alpha/refused-pod")).toHaveTextContent(reason);
    // Said only where it applies, not under every pod.
    expect(cardFor("beta/allowed-pod")).not.toHaveTextContent(reason);
    expect(cardFor("gamma/unknown-pod")).not.toHaveTextContent(reason);
  });

  // Nothing on this screen can show or change a namespace, so sending one
  // only invites a decision taken on the wrong namespace.
  it("asks for the node area without a namespace", async () => {
    const fetchMock = renderNodes();
    await screen.findByText("alpha/refused-pod");
    const asked = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/operations"));
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(url).not.toContain("namespace=");
  });
});
