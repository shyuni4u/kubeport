import { describe, expect, it } from "vitest";

import {
  addressable,
  formatSegment,
  joinPath,
  parsePathSegments,
  parseTemplatePath,
  splitHead,
} from "./template-path";

// This module is the single definition of the path grammar on the frontend.
// Three copies of it used to exist (two in Go, one here) and issue #129 was
// present in all of them: a Kubernetes map key carrying `.`, `-` or `/` could
// be generated but not parsed back.

describe("formatSegment", () => {
  it("leaves identifier-shaped keys bare", () => {
    expect(formatSegment("replicas")).toBe("replicas");
    expect(formatSegment("_private")).toBe("_private");
    expect(formatSegment("containers0")).toBe("containers0");
  });

  it("quotes keys that the bare form cannot express", () => {
    // Each of these is a real Kubernetes key shape: a recommended label, an
    // annotation, a hyphenated name, a ConfigMap data filename.
    expect(formatSegment("app.kubernetes.io/name")).toBe('["app.kubernetes.io/name"]');
    expect(formatSegment("app-tier")).toBe('["app-tier"]');
    expect(formatSegment("nginx.conf")).toBe('["nginx.conf"]');
    expect(formatSegment("80")).toBe('["80"]');
  });

  it("switches quote style rather than escaping", () => {
    expect(formatSegment('say"hi')).toBe(`['say"hi']`);
  });

  it("round-trips every shape it emits", () => {
    for (const key of [
      "replicas",
      "app.kubernetes.io/name",
      "app-tier",
      "nginx.conf",
      "80",
      'say"hi',
      "it's",
      "",
    ]) {
      const seg = formatSegment(key);
      expect(seg, `${key} must be addressable`).not.toBeNull();
      expect(parsePathSegments(seg!)).toEqual([key]);
    }
  });

  it("refuses a key holding both quote styles rather than emitting a broken path", () => {
    // There is no escape character, so `['a"b'c']` would parse as something
    // else entirely. Refuse where the key is still in hand.
    expect(addressable(`a"b'c`)).toBe(false);
    expect(formatSegment(`a"b'c`)).toBeNull();
    expect(joinPath("data", `a"b'c`)).toBeNull();
    expect(addressable('say"hi')).toBe(true);
    expect(addressable("it's")).toBe(true);
  });
});

describe("parsePathSegments", () => {
  it("treats a quoted segment as one key, dots included", () => {
    expect(parsePathSegments('metadata.labels["app.kubernetes.io/name"]')).toEqual([
      "metadata",
      "labels",
      "app.kubernetes.io/name",
    ]);
  });

  it("keeps array indices numeric and map keys textual", () => {
    // ["0"] is the string key "0"; [0] is the first element. The distinction
    // is what lets a ConfigMap with numeric-looking keys coexist with arrays.
    expect(parsePathSegments("spec.containers[0].image")).toEqual(["spec", "containers", 0, "image"]);
    expect(parsePathSegments('data["0"]')).toEqual(["data", "0"]);
  });

  it("accepts both quote styles", () => {
    expect(parsePathSegments(`data['app.properties']`)).toEqual(["data", "app.properties"]);
  });

  it("rejects malformed input rather than guessing", () => {
    // Returning null matters more than the specific shape: applyValuesToYaml
    // skips unparseable paths, so a lenient parser would silently write to the
    // wrong key instead of leaving the document alone.
    expect(parsePathSegments('data["unterminated')).toBeNull();
    expect(parsePathSegments('data["key"')).toBeNull();
    expect(parsePathSegments("spec.containers[-1]")).toBeNull();
    expect(parsePathSegments("spec.containers[x]")).toBeNull();
    expect(parsePathSegments("spec..-bad")).toBeNull();
  });
});

describe("parseTemplatePath", () => {
  it("splits the Kind[selector] head from the segments", () => {
    expect(parseTemplatePath("Deployment[web].spec.replicas")).toEqual({
      kind: "Deployment",
      selector: "web",
      keys: ["spec", "replicas"],
    });
  });

  it("allows the selector to be omitted", () => {
    expect(parseTemplatePath("Deployment.spec.replicas")).toEqual({
      kind: "Deployment",
      selector: "",
      keys: ["spec", "replicas"],
    });
  });

  it("does not read a quoted first segment as the selector", () => {
    // `Kind["a.b"]` is a top-level key that needs quoting, not a resource
    // named `"a.b"`. A selector is an index or a metadata.name, and neither
    // can start with a quote.
    expect(parseTemplatePath('ConfigMap["a.b"]')).toEqual({
      kind: "ConfigMap",
      selector: "",
      keys: ["a.b"],
    });
  });

  it("carries a quoted segment through the head split", () => {
    expect(parseTemplatePath('Deployment[web].metadata.labels["app.kubernetes.io/name"]')).toEqual({
      kind: "Deployment",
      selector: "web",
      keys: ["metadata", "labels", "app.kubernetes.io/name"],
    });
  });
});

describe("splitHead", () => {
  it("returns the tail unparsed so callers decide whether to canonicalize", () => {
    expect(splitHead(`Deployment[web].spec['replicas']`)).toEqual({
      kind: "Deployment",
      selector: "web",
      rest: `spec['replicas']`,
    });
  });

  it("accepts an omitted selector", () => {
    // openapi.yaml documents `Deployment.spec.replicas` as valid. The regex
    // this replaced required a selector, so this shape was reported
    // unparseable — and in yaml-to-ui-state that demoted an exposed field
    // back to fixed, removing it from the deploy form.
    expect(splitHead("Deployment.spec.replicas")).toEqual({
      kind: "Deployment",
      selector: "",
      rest: "spec.replicas",
    });
  });

  it("accepts an index selector", () => {
    expect(splitHead("Deployment[0].spec.replicas")).toEqual({
      kind: "Deployment",
      selector: "0",
      rest: "spec.replicas",
    });
  });
});
