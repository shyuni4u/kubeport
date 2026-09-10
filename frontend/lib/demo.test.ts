import { describe, expect, it } from "vitest";
import { isDemoEmail, withDemoSuffix } from "./demo";

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
});
