import { describe, it, expect } from "vitest";
import { MonacoPanel } from "./MonacoPanel";

describe("MonacoPanel module", () => {
  it("exports a function component", () => {
    expect(typeof MonacoPanel).toBe("function");
  });
});
