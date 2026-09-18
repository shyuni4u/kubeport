import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { OperationsDashboard } from "./OperationsDashboard";

afterEach(() => vi.unstubAllGlobals());
describe("operations dashboard", () => {
  it("refreshes recovered workloads and keeps failed probes visible", async () => {
    let recovered = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("?")
          ? Response.json({
              releases: [
                {
                  id: "a",
                  name: "web",
                  namespace: "team",
                  cluster_name: "prod",
                },
                {
                  id: "b",
                  name: "worker",
                  namespace: "team",
                  cluster_name: "prod",
                },
              ],
            })
          : url.endsWith("/a")
            ? Response.json({ status: recovered ? "healthy" : "error" })
            : new Response("", { status: 403 }),
      ),
    );
    render(<OperationsDashboard />);
    await screen.findByText("조회 실패");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute(
      "href",
      "/releases/a",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled(),
    );
    recovered = true;
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "web" }).closest("li"),
      ).toHaveTextContent("정상"),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("link", { name: "web" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "worker" })).toBeVisible();
  });
  it("does not present a list failure as an empty deployment list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    render(<OperationsDashboard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("조회에 실패");
    expect(
      screen.queryByText("아직 등록된 배포가 없습니다."),
    ).not.toBeInTheDocument();
  });
});
