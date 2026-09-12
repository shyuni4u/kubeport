import { describe, it, expect, beforeEach } from "vitest";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { ReleaseMeta } from "./ReleaseMeta";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

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
    expect(text).toContain("클러스터 oci-a1");
    expect(text).toContain("구역 demo");
    expect(text).not.toContain("oci-a1 / demo");
  });

  it("uses the Kubernetes word for the namespace with the terms switch on", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    const { container } = render(<ReleaseMeta {...props} />);
    expect(container.textContent).toContain("Namespace demo");
    expect(container.textContent).not.toContain("구역 demo");
  });

  it("keeps the deploy time when there is one", () => {
    const { container } = render(
      <ReleaseMeta {...props} createdAt={new Date().toISOString()} />,
    );
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).toContain("배포");
  });
});
