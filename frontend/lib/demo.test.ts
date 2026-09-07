import { describe, expect, it } from "vitest";
import { isDemoEmail, nextResetAt, withDemoSuffix } from "./demo";

describe("demo helpers", () => {
  it("isDemoEmail matches the demo domain case-insensitively", () => {
    expect(isDemoEmail("demo-user@demo.kubeport", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("X@DEMO.KUBEPORT", "demo.kubeport")).toBe(true);
    expect(isDemoEmail("a@example.com", "demo.kubeport")).toBe(false);
    expect(isDemoEmail(null, "demo.kubeport")).toBe(false);
  });
  it("nextResetAt returns the next 6h UTC boundary", () => {
    expect(nextResetAt(new Date("2026-09-07T05:59:00Z")).toISOString()).toBe("2026-09-07T06:00:00.000Z");
    expect(nextResetAt(new Date("2026-09-07T06:00:00Z")).toISOString()).toBe("2026-09-07T12:00:00.000Z");
    expect(nextResetAt(new Date("2026-09-07T23:30:00Z")).toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
  it("withDemoSuffix appends 4 chars only for demo users", () => {
    expect(withDemoSuffix("web-app", false)).toBe("web-app");
    expect(withDemoSuffix("web-app", true, () => 0)).toBe("web-app-aaaa");
    expect(withDemoSuffix("web-app", true)).toMatch(/^web-app-[a-z0-9]{4}$/);
  });
});
