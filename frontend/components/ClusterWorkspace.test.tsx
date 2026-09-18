import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ClusterWorkspace } from "./ClusterWorkspace";
import { ErrorDetailProvider } from "./ErrorDetailProvider";

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
  });
});
