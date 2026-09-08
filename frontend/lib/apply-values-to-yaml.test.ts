import { describe, expect, it } from "vitest";

import { applyValuesToYaml, changedLineRange } from "./apply-values-to-yaml";

const src = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  # how many
  replicas: 1
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.27
          env:
            - name: MSG
              value: "hello"
`;

describe("applyValuesToYaml", () => {
  it("replaces scalars addressed by Kind[name].path and array index", () => {
    const out = applyValuesToYaml(src, {
      "Deployment[web].spec.replicas": 3,
      "Deployment[web].spec.template.spec.containers[0].env[0].value": "bye",
      "ConfigMap[cfg].data.LOG_LEVEL": "debug",
    });
    expect(out).toContain("replicas: 3");
    // original quoting style is preserved by the yaml Document API
    expect(out).toContain('value: "bye"');
    expect(out).toContain("LOG_LEVEL: debug");
    expect(out).not.toContain("replicas: 1");
  });

  it("keeps comments, document order and separators", () => {
    const out = applyValuesToYaml(src, { "Deployment[web].spec.replicas": 2 });
    expect(out).toContain("# how many");
    expect(out.indexOf("kind: ConfigMap")).toBeLessThan(out.indexOf("kind: Deployment"));
    expect(out.split("\n---\n")).toHaveLength(2);
  });

  it("is a no-op for empty values and stable across repeated application", () => {
    const once = applyValuesToYaml(src, {});
    const twice = applyValuesToYaml(once, {});
    expect(twice).toBe(once);
  });

  it("ignores unknown paths, unknown kinds and undefined values", () => {
    const base = applyValuesToYaml(src, {});
    const out = applyValuesToYaml(src, {
      "Deployment[web].spec.nope.deeper": 1,
      "StatefulSet[web].spec.replicas": 1,
      "Deployment[other].spec.replicas": 1,
      "Deployment[web].spec.replicas": undefined,
    });
    expect(out).toBe(base);
  });

  it("selects the only document of a kind when no selector is given", () => {
    const out = applyValuesToYaml(src, { "Deployment.spec.replicas": 5 });
    expect(out).toContain("replicas: 5");
  });
});

describe("changedLineRange", () => {
  it("returns null when texts are identical", () => {
    expect(changedLineRange("a\nb\nc", "a\nb\nc")).toBeNull();
  });

  it("returns the inclusive zero-based line span that differs", () => {
    expect(changedLineRange("a\nb\nc\nd", "a\nB\nc\nd")).toEqual([1, 1]);
    expect(changedLineRange("a\nb\nc\nd", "a\nB\nC\nd")).toEqual([1, 2]);
  });

  it("handles inserted lines by spanning the inserted block", () => {
    expect(changedLineRange("a\nb\nc", "a\nb\nx\ny\nc")).toEqual([2, 3]);
  });
});
