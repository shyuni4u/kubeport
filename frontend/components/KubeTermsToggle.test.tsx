import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { KubeTermsToggle } from "./KubeTermsToggle";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

describe("KubeTermsToggle", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  // #249 — "원본 k8s 용어 보기" said neither what k8s is nor what the switch changes.
  it("names Kubernetes in full as the switch's name", () => {
    render(<KubeTermsToggle />);
    expect(
      screen.getByRole("switch", { name: "Kubernetes 원래 이름으로 보기" }),
    ).toBeInTheDocument();
  });

  it("offers a help hint beside the switch, outside its label", () => {
    render(<KubeTermsToggle />);
    const help = screen.getByRole("button", { name: "도움말" });
    expect(help.closest("label")).toBeNull();
  });

  it("flips the shared store the other pages read", () => {
    render(<KubeTermsToggle />);
    fireEvent.click(screen.getByRole("switch"));
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(true);
    expect(useKubeTermsStore.getState().touched).toBe(true);
  });
});
