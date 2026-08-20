import { describe, it, expect } from "vitest";
import { iconFor } from "./template-icons";
import { Box, Database, Globe, Server } from "lucide-react";

describe("iconFor", () => {
  it("returns Globe for 'web' tag", () => {
    expect(iconFor(["web"])).toBe(Globe);
  });
  it("returns Database for 'database' tag", () => {
    expect(iconFor(["database"])).toBe(Database);
  });
  it("returns Server for 'backend' tag", () => {
    expect(iconFor(["backend"])).toBe(Server);
  });
  it("prefers first matching tag when multiple", () => {
    expect(iconFor(["unknown", "web"])).toBe(Globe);
  });
  it("returns fallback Box when no tag matches", () => {
    expect(iconFor(["unknown"])).toBe(Box);
  });
  it("returns fallback Box on empty/undefined tags", () => {
    expect(iconFor([])).toBe(Box);
    expect(iconFor(undefined)).toBe(Box);
  });
});
