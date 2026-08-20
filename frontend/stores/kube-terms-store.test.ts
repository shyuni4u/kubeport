import { describe, it, expect, beforeEach } from "vitest";
import { useKubeTermsStore } from "./kube-terms-store";

describe("useKubeTermsStore", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false });
  });

  it("defaults showKubeTerms to false", () => {
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });

  it("toggle() flips the flag", () => {
    useKubeTermsStore.getState().toggle();
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(true);
    useKubeTermsStore.getState().toggle();
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });
});
