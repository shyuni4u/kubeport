import { describe, expect, it } from "vitest";

import { parsePathSegments } from "./template-path";

// Mirrors maxPathDepth in backend/internal/template/jsonpath.go. The backend
// needs the limit because depth costs it quadratically when it builds and
// encodes the document (issue #135: 16KB of path text produced 64MB of
// resources.yaml). This side needs the same number so the two agree on what a
// path is — a parser that accepted more would hand the admin a 400 on save
// with nothing on screen saying which key did it.
describe("path depth", () => {
  it("refuses a path deeper than the backend will accept", () => {
    expect(parsePathSegments("a.".repeat(200) + "x")).toBeNull();
  });

  it("accepts depth the backend accepts", () => {
    expect(parsePathSegments("a.".repeat(127) + "x")).toHaveLength(128);
  });

  it("leaves real manifest paths alone — they run about nine deep", () => {
    expect(
      parsePathSegments("spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name"),
    ).toEqual([
      "spec",
      "template",
      "spec",
      "containers",
      0,
      "env",
      0,
      "valueFrom",
      "secretKeyRef",
      "name",
    ]);
  });
});
