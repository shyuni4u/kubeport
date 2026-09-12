import { describe, it, expect } from "vitest";
import { utcOffsetLabel } from "./utc-offset";

const AT = new Date("2026-09-09T10:00:00.000Z");

// #142 — the label must read the same on the server and in any browser, so it
// is computed, not looked up as an ICU zone name.
describe("utcOffsetLabel", () => {
  it("labels the app's zone", () => {
    expect(utcOffsetLabel(AT, "Asia/Seoul")).toBe("UTC+9");
  });

  it("says plain UTC for a zero offset", () => {
    expect(utcOffsetLabel(AT, "UTC")).toBe("UTC");
  });

  it("keeps the minutes of a half-hour zone", () => {
    expect(utcOffsetLabel(AT, "Asia/Kolkata")).toBe("UTC+5:30");
  });

  it("follows daylight saving at the given instant", () => {
    expect(utcOffsetLabel(new Date("2026-07-01T12:00:00Z"), "America/New_York")).toBe("UTC-4");
    expect(utcOffsetLabel(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe("UTC-5");
  });

  it("gives no label without a zone, for an unknown zone, or for an invalid date", () => {
    expect(utcOffsetLabel(AT, undefined)).toBeNull();
    expect(utcOffsetLabel(AT, "Not/AZone")).toBeNull();
    expect(utcOffsetLabel(new Date("nope"), "Asia/Seoul")).toBeNull();
  });
});
