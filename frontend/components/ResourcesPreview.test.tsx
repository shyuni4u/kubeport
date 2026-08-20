import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResourcesPreview } from "./ResourcesPreview";

describe("ResourcesPreview", () => {
  it("shows placeholder when renderedYaml is null and not pending", () => {
    render(<ResourcesPreview renderedYaml={null} pending={false} />);
    expect(
      screen.getByText("폼을 채우면 미리보기가 여기 표시됩니다."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("shows placeholder when renderedYaml is an empty string", () => {
    render(<ResourcesPreview renderedYaml="" pending={false} />);
    expect(
      screen.getByText("폼을 채우면 미리보기가 여기 표시됩니다."),
    ).toBeInTheDocument();
  });

  it("shows pending status while fetching", () => {
    render(<ResourcesPreview renderedYaml={null} pending={true} />);
    expect(screen.getByText("렌더링 중…")).toBeInTheDocument();
    expect(
      screen.queryByText("폼을 채우면 미리보기가 여기 표시됩니다."),
    ).not.toBeInTheDocument();
  });

  it("renders each kind + name for a valid multi-doc YAML", () => {
    const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("Deployment")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("Service")).toBeInTheDocument();
    expect(screen.getByText("web-svc")).toBeInTheDocument();
    // Two items listed
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows (unnamed) when metadata.name is missing", () => {
    const yaml = `apiVersion: v1
kind: ConfigMap
data:
  foo: bar
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("ConfigMap")).toBeInTheDocument();
    expect(screen.getByText("(unnamed)")).toBeInTheDocument();
  });

  it("skips docs without kind", () => {
    const yaml = `apiVersion: v1
metadata:
  name: no-kind
---
apiVersion: v1
kind: Secret
metadata:
  name: real
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("Secret")).toBeInTheDocument();
    expect(screen.getByText("real")).toBeInTheDocument();
    expect(screen.queryByText("no-kind")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("falls back to placeholder on malformed YAML (no crash)", () => {
    // parseAllDocuments is forgiving and rarely throws, but bracket-scalar mismatches can.
    // Even if it returns empty / invalid docs, the filter should eliminate them → placeholder.
    const yaml = "kind: [unterminated";
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(
      screen.getByText("폼을 채우면 미리보기가 여기 표시됩니다."),
    ).toBeInTheDocument();
  });
});
