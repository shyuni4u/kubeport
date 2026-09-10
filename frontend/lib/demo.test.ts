import { describe, expect, it } from "vitest";
import { demoNamespaceFor, isDemoEmail, withDemoSuffix } from "./demo";
import { releaseNameProblem } from "./release-name";

describe("demo helpers", () => {
  it("isDemoEmail matches the demo domain case-insensitively", () => {
    expect(isDemoEmail("demo-user@demo.kubeport", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("X@DEMO.KUBEPORT", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("a@example.com", "demo.kubeport")).toBe(false);
    expect(isDemoEmail(null, "demo.kubeport")).toBe(false);
  });
  it("withDemoSuffix appends 4 chars only for demo users", () => {
    expect(withDemoSuffix("web-app", false)).toBe("web-app");
    expect(withDemoSuffix("web-app", true, () => 0)).toBe("web-app-aaaa");
    expect(withDemoSuffix("web-app", true)).toMatch(/^web-app-[a-z0-9]{4}$/);
  });
  // #182 — the demo default prefills a form that accepts only a lowercase
  // DNS-1123 label, and template names are not validated, so the prefill must
  // pass whatever the template is called.
  it.each(["WebApp", "web.app", "My Template_2", "a".repeat(80), "한글", "--x--"])(
    "withDemoSuffix gives %j a name the deploy form accepts",
    (name) => {
      const out = withDemoSuffix(name, true);
      expect(releaseNameProblem(out)).toBeNull();
    },
  );
  it("withDemoSuffix folds a non-slug template name rather than dropping it", () => {
    expect(withDemoSuffix("WebApp", true, () => 0)).toBe("webapp-aaaa");
    expect(withDemoSuffix("web.app", true, () => 0)).toBe("web-app-aaaa");
    expect(withDemoSuffix("한글", true, () => 0)).toBe("aaaa");
  });
  // #179 — demo accounts can write only to the demo namespace.
  it("demoNamespaceFor gives the demo namespace to demo sessions only", () => {
    expect(demoNamespaceFor("demo-user@demo.kubeport", "demo", "demo.kubeport")).toBe("demo");
    expect(demoNamespaceFor("alice@example.com", "demo", "demo.kubeport")).toBeUndefined();
    expect(demoNamespaceFor(null, "demo", "demo.kubeport")).toBeUndefined();
  });
  // An install without demo mode renders no DEMO_NAMESPACE; a blank value must
  // not become an empty-string namespace that hides the cluster's own default.
  it("demoNamespaceFor is undefined when no demo namespace is configured", () => {
    expect(demoNamespaceFor("demo-user@demo.kubeport", undefined, "demo.kubeport")).toBeUndefined();
    expect(demoNamespaceFor("demo-user@demo.kubeport", "  ", "demo.kubeport")).toBeUndefined();
  });
});
