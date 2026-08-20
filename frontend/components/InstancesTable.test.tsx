import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstancesTable } from "./InstancesTable";

describe("InstancesTable", () => {
  it("renders instance rows with logs link", () => {
    render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /로그/ });
    expect(link).toHaveAttribute("href", "/releases/abc/logs?instance=pod-1");
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
