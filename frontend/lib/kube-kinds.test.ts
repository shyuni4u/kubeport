import { describe, it, expect } from "vitest";
import { kindLabel } from "./kube-kinds";

// Moved from KubeTermsDefault.test.tsx when that component went away (#247).
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
