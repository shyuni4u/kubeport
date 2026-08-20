import { describe, it, expect } from "vitest";
import { roleFromGroups } from "./role";

describe("roleFromGroups", () => {
  it("returns 'admin' when groups include kubeport-admin", () => {
    expect(roleFromGroups(["kubeport-admin", "dev"])).toBe("admin");
  });

  it("returns 'user' when groups lack kubeport-admin", () => {
    expect(roleFromGroups(["dev", "qa"])).toBe("user");
  });

  it("returns 'user' on null/undefined groups", () => {
    expect(roleFromGroups(null)).toBe("user");
    expect(roleFromGroups(undefined)).toBe("user");
  });

  it("returns 'user' on empty array", () => {
    expect(roleFromGroups([])).toBe("user");
  });
});
