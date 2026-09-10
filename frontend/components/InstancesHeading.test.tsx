import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { InstancesHeading } from "./InstancesHeading";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

// #250 — the heading stayed "인스턴스 (n)" above a table whose headers said
// "Pod Name" with raw terms on.
describe("InstancesHeading", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  it("uses the plain word by default", () => {
    render(<InstancesHeading count={2} />);
    expect(screen.getByRole("heading", { name: "인스턴스 (2)" })).toBeInTheDocument();
  });

  it("uses the k8s word with raw terms on, like the table under it", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<InstancesHeading count={2} />);
    expect(screen.getByRole("heading", { name: "Pods (2)" })).toBeInTheDocument();
  });
});
