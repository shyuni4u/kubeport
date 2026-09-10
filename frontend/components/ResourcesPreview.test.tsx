import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ResourcesPreview } from "./ResourcesPreview";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

describe("ResourcesPreview", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  it("shows placeholder when renderedYaml is null and not pending", () => {
    render(<ResourcesPreview renderedYaml={null} pending={false} />);
    expect(
      screen.getByText("폼을 채우면 여기에 미리보기가 표시됩니다."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("shows placeholder when renderedYaml is an empty string", () => {
    render(<ResourcesPreview renderedYaml="" pending={false} />);
    expect(
      screen.getByText("폼을 채우면 여기에 미리보기가 표시됩니다."),
    ).toBeInTheDocument();
  });

  it("shows pending status while fetching", () => {
    render(<ResourcesPreview renderedYaml={null} pending={true} />);
    expect(screen.getByText("미리보기 준비 중…")).toBeInTheDocument();
    expect(screen.getByText("만들어질 것")).toBeInTheDocument();
    expect(
      screen.queryByText("폼을 채우면 여기에 미리보기가 표시됩니다."),
    ).not.toBeInTheDocument();
  });

  // #39 — a user met "Deployment" and "Service" here and nowhere else.
  it("names each resource in plain words by default", () => {
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
    expect(screen.getByText("앱")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("내부 주소")).toBeInTheDocument();
    expect(screen.getByText("web-svc")).toBeInTheDocument();
    expect(screen.queryByText("Deployment")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  // An admin reading raw terms wants what the manifest says: a kind name alone
  // cannot tell batch/v1 from a CRD.
  it("shows apiVersion and kind once the raw-terms switch is on", () => {
    const yaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    fireEvent.click(screen.getByRole("switch", { name: "Kubernetes 원래 이름으로 보기" }));
    expect(screen.getByText("apps/v1 Deployment")).toBeInTheDocument();
    expect(screen.queryByText("앱")).not.toBeInTheDocument();
    expect(useKubeTermsStore.getState().touched).toBe(true);
  });

  it("keeps a kind with no plain name as it is", () => {
    const yaml = `apiVersion: example.com/v1
kind: Widget
metadata:
  name: w
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("Widget")).toBeInTheDocument();
  });

  // Knative's Service is not a core Service; "내부 주소" would describe
  // something it is not.
  it("keeps a CRD that reuses a core kind name as written", () => {
    const yaml = `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("Service")).toBeInTheDocument();
    expect(screen.queryByText("내부 주소")).not.toBeInTheDocument();
  });

  it("says the resource has no name, in the page's language, when metadata.name is missing", () => {
    const yaml = `apiVersion: v1
kind: ConfigMap
data:
  foo: bar
`;
    render(<ResourcesPreview renderedYaml={yaml} pending={false} />);
    expect(screen.getByText("설정")).toBeInTheDocument();
    expect(screen.getByText("(이름 없음)")).toBeInTheDocument();
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
    expect(screen.getByText("비밀값")).toBeInTheDocument();
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
      screen.getByText("폼을 채우면 여기에 미리보기가 표시됩니다."),
    ).toBeInTheDocument();
  });
});
