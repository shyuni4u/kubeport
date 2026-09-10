import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { InstancesTable } from "./InstancesTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

describe("InstancesTable", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  /**
   * #130 was reported against *this* table, and #106 fixed a different one.
   *
   * The two release tables are built differently — ReleaseTable writes its own
   * `<tr>`, this one goes through `ui/table`'s TableRow — so raising the hover
   * on the release *list* left the release *detail* on `hover:bg-muted/50`
   * (1.064:1) for another release cycle. Asserting the rendered class here, in
   * the component the issue names, is what closes that gap: a hover token that
   * stops reaching this table fails in the file it was reported against.
   */
  it("gives its rows a visible hover, through ui/table (#130)", () => {
    render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    const row = screen.getByText("pod-1").closest("tr");
    expect(row?.className).toContain("hover:bg-hover");
    expect(row?.className).not.toMatch(/hover:bg-muted/);
  });

  it("renders instance rows with logs link", () => {
    render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(screen.getByText("실행 중")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /로그/ });
    expect(link).toHaveAttribute("href", "/releases/abc/logs?instance=pod-1");
  });

  it("renders friendly column headers by default and raw k8s terms when toggled", () => {
    const { unmount } = render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.getByText("인스턴스 ID")).toBeInTheDocument();
    expect(screen.getByText("상태")).toBeInTheDocument();
    unmount();

    useKubeTermsStore.setState({ showKubeTerms: true });
    render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.getByText("Pod Name")).toBeInTheDocument();
    expect(screen.getByText("Phase")).toBeInTheDocument();
  });

  // #114 — an empty <tbody> left the three column headers floating over blank
  // space. Nothing said whether the table was loading, broken, or just empty.
  describe("with no instances", () => {
    it("says the table is empty instead of rendering nothing", () => {
      render(<InstancesTable releaseId="abc" instances={[]} />);
      expect(
        screen.getByText("실행 중인 인스턴스가 없습니다."),
      ).toBeInTheDocument();
    });

    // "See the notice above" is only true when ReleaseStaleBanner is above it.
    // An empty table is otherwise perfectly ordinary — a CronJob between runs,
    // a Deployment scaled to zero — and pointing at a notice that is not on
    // the page sends the reader looking for something that does not exist.
    it("points at the stale banner only when there is one", () => {
      const { unmount } = render(
        <InstancesTable releaseId="abc" instances={[]} />,
      );
      expect(screen.queryByText(/위 안내/)).toBeNull();
      unmount();

      render(<InstancesTable releaseId="abc" instances={[]} staleNotice />);
      expect(screen.getByText(/위 안내를 확인해 주세요/)).toBeInTheDocument();
    });

    it("keeps the empty row spanning the full width of the header", () => {
      render(<InstancesTable releaseId="abc" instances={[]} />);
      const cell = screen
        .getByText("실행 중인 인스턴스가 없습니다.")
        .closest("td");
      const headers = document.querySelectorAll("thead th");
      expect(cell).toHaveAttribute("colSpan", String(headers.length));
    });
  });

  it("renders multiple rows", () => {
    render(
      <InstancesTable
        releaseId="abc"
        instances={[
          { name: "pod-1", phase: "Running", ready: true, restarts: 0 },
          { name: "pod-2", phase: "Pending", ready: false, restarts: 3 },
        ]}
      />,
    );
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(screen.getByText("pod-2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
