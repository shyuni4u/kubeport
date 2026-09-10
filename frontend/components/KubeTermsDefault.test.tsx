import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { KubeTermsDefault } from "./KubeTermsDefault";
import { useKubeTermsStore } from "@/stores/kube-terms-store";
import { kindLabel } from "@/lib/kube-kinds";

// #39 — admins write templates in k8s words and users never see them
// anywhere else, so each starts on the side they need; a choice the viewer
// made during the visit is never taken back.
describe("KubeTermsDefault", () => {
  beforeEach(() => {
    useKubeTermsStore.setState({ showKubeTerms: false, touched: false });
  });

  it("turns raw terms on for an admin", () => {
    render(<KubeTermsDefault isAdmin />);
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(true);
  });

  it("leaves them off for a user", () => {
    useKubeTermsStore.setState({ showKubeTerms: true });
    render(<KubeTermsDefault isAdmin={false} />);
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(false);
  });

  it("does not override a choice the viewer already made", () => {
    useKubeTermsStore.getState().toggle(); // user turned raw terms on
    render(<KubeTermsDefault isAdmin={false} />);
    expect(useKubeTermsStore.getState().showKubeTerms).toBe(true);
  });
});

describe("kindLabel", () => {
  const t = (k: string) => `friendly:${k}`;

  it("uses the plain name for a known kind", () => {
    expect(kindLabel("ConfigMap", false, t)).toBe("friendly:ConfigMap");
  });

  it("shows the raw kind when raw terms are on", () => {
    expect(kindLabel("ConfigMap", true, t)).toBe("ConfigMap");
  });

  it("keeps an unknown kind as it is instead of asking for a missing message", () => {
    expect(kindLabel("Widget", false, t)).toBe("Widget");
  });

  // A kind name is not an identity: Knative's Service is not a core Service.
  it("keeps a CRD that reuses a core kind name as written", () => {
    expect(kindLabel("Service", false, t, "serving.knative.dev/v1")).toBe("Service");
    expect(kindLabel("Service", false, t, "v1")).toBe("friendly:Service");
    expect(kindLabel("Deployment", false, t, "apps/v1")).toBe("friendly:Deployment");
    expect(kindLabel("CronJob", false, t, "batch/v1")).toBe("friendly:CronJob");
  });
});
