import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { InstancesTable } from "./InstancesTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

describe("InstancesTable", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
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
