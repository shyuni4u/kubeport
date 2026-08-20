import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricCards } from "./MetricCards";

describe("MetricCards", () => {
  it("renders ready/total instances and restarts", () => {
    render(
      <MetricCards readyTotal={[2, 3]} restarts={1} memory={null} accessURL={null} />,
    );
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(2);
  });

  it("renders memory and accessURL when provided", () => {
    render(
      <MetricCards
        readyTotal={[1, 1]}
        restarts={0}
        memory="128Mi"
        accessURL="my-svc.default.svc.cluster.local"
      />,
    );
    expect(screen.getByText("128Mi")).toBeInTheDocument();
    expect(screen.getByText("my-svc.default.svc.cluster.local")).toBeInTheDocument();
  });
});
