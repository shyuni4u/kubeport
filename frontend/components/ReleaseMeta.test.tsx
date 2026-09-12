import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ReleaseMeta } from "./ReleaseMeta";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

const NBSP = " ";
const props = { template: "web-app", version: 1, cluster: "oci-a1", namespace: "demo" };

// #259 — the header said "oci-a1 / demo", and nothing said "demo" was the 구역
// the release was deployed into.
describe("ReleaseMeta", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  it("names the cluster and the 구역 it shows", () => {
    const { container } = render(<ReleaseMeta {...props} />);
    const text = container.textContent ?? "";
    expect(text).toContain("web-app v1");
    expect(text).toContain(`클러스터${NBSP}oci-a1`);
    expect(text).toContain(`구역${NBSP}demo`);
    expect(text).not.toContain("oci-a1 / demo");
  });

  // A plain space let a narrow screen end a line on the label and start the
  // next on its value, and start a line with the separator.
  it("keeps each label on the same line as its value, and each separator after its segment", () => {
    const { container } = render(<ReleaseMeta {...props} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/클러스터 |구역 | ·/);
    expect(text).toContain(`${NBSP}· `);
  });

  it("explains 클러스터 behind a help hint, in the deploy form's words", () => {
    render(<ReleaseMeta {...props} />);
    expect(screen.getByRole("button", { name: "도움말" })).toBeInTheDocument();
  });

  it("uses the Kubernetes word for the namespace with the terms switch on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    const { container } = render(<ReleaseMeta {...props} />);
    expect(container.textContent).toContain(`Namespace${NBSP}demo`);
    expect(container.textContent).not.toContain("구역");
  });

  // The cluster label stays Korean with raw terms on — it is kubeport's name for
  // the cluster, not a k8s term — so pin the whole line: adding a raw "Cluster"
  // here would split it from the deploy form, which keeps "클러스터" too.
  it("keeps 클러스터 and switches only the namespace label with raw terms on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    const { container } = render(<ReleaseMeta {...props} />);
    expect(container.textContent).toBe(
      `web-app v1${NBSP}· 클러스터${NBSP}oci-a1${NBSP}· Namespace${NBSP}demo`,
    );
  });

  it("keeps the deploy time when there is one", () => {
    const { container } = render(
      <ReleaseMeta {...props} createdAt={new Date().toISOString()} />,
    );
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).toContain("배포");
  });
});
