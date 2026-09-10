import { describe, it, expect } from "vitest";
import { problemTitle } from "./problem";

describe("problemTitle", () => {
  it("reads the kind from a Problem body", () => {
    expect(
      problemTitle('{"type":"about:blank","title":"demo-restricted","status":403,"request_id":"r1"}'),
    ).toBe("demo-restricted");
  });

  // A proxy's HTML error page, an empty body, or a JSON body that is not a
  // Problem must not be mistaken for a kind — the caller falls back to its
  // status-based sentence.
  it("is undefined for anything that is not a Problem", () => {
    expect(problemTitle("")).toBeUndefined();
    expect(problemTitle("<html>502 Bad Gateway</html>")).toBeUndefined();
    expect(problemTitle('{"error":"draft exists"}')).toBeUndefined();
    expect(problemTitle('{"title":42}')).toBeUndefined();
    expect(problemTitle('{"title":""}')).toBeUndefined();
    expect(problemTitle("null")).toBeUndefined();
  });
});
