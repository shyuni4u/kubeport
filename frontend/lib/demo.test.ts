import { describe, expect, it } from "vitest";
import { demoNamespaceFor, isDemoEmail, withDemoSuffix } from "./demo";

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
