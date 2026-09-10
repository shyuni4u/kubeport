import { describe, expect, it } from "vitest";

import { normalizeUISpec, uiSpecIssues, uiSpecProblems, type UISpec } from "./ui-spec-to-zod";

// Raw specs here are what the admin is typing, not what the type promises.
const raw = (fields: unknown[]) => ({ fields }) as unknown as UISpec;

describe("normalizeUISpec — a blank label (#152)", () => {
  // An exposed field with no label reached the form as an input with nothing
  // beside it, which read as "exposing did nothing".
  it("names the field after the last key of its path", () => {
    const { spec } = normalizeUISpec(
      raw([
        { path: "ConfigMap[web-config].metadata.labels", label: "", type: "string" },
        { path: "Deployment[web].spec.template.spec.containers[0].image", label: "   ", type: "string" },
        { path: 'ConfigMap[conf].data["nginx.conf"]', label: "", type: "string" },
        { path: "CronJob[nightly].spec.jobTemplate.spec.template.spec.containers[0].args[1]", type: "string" },
      ]),
    );

    expect(spec.fields.map((f) => f.label)).toEqual(["labels", "image", "nginx.conf", "args"]);
  });

  it("keeps a label that was written", () => {
    const { spec } = normalizeUISpec(
      raw([{ path: "Deployment[web].spec.replicas", label: "동시에 띄울 개수", type: "integer" }]),
    );

    expect(spec.fields[0].label).toBe("동시에 띄울 개수");
  });

  // A fallback is not a problem to report: the field renders, with a name.
  it("does not report a blank label as an issue", () => {
    const result = normalizeUISpec(raw([{ path: "Deployment[web].spec.replicas", label: "", type: "integer" }]));

    expect(result.problems).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.ignored).toEqual([]);
  });
});

describe("uiSpecIssues — dropped versus ignored (#197)", () => {
  it("calls an unknown type, or an enum without values, dropped", () => {
    expect(
      uiSpecIssues(
        raw([
          { path: "a", label: "a", type: "sxtring" },
          { path: "b", label: "b", type: "enum" },
        ]),
      ),
    ).toEqual([
      { at: 'fields[0].type: "sxtring"', kind: "dropped" },
      { at: "fields[1].values (enum)", kind: "dropped" },
    ]);
  });

  // The field stays on screen; only the setting is set aside. Reporting these
  // as "left out" sent the admin looking for a row that was still there.
  it("calls an uncompilable pattern, or autocomplete without values, ignored", () => {
    const spec = raw([
      { path: "a", label: "a", type: "string", pattern: "[" },
      { path: "b", label: "b", type: "autocomplete" },
    ]);

    expect(uiSpecIssues(spec)).toEqual([
      { at: "fields[0].pattern", kind: "ignored" },
      { at: "fields[1].values (autocomplete)", kind: "ignored" },
    ]);
    const result = normalizeUISpec(spec);
    expect(result.spec.fields.map((f) => f.path)).toEqual(["a", "b"]);
    expect(result.dropped).toEqual([]);
    expect(result.ignored).toEqual(["fields[0].pattern", "fields[1].values (autocomplete)"]);
  });

  it("keeps uiSpecProblems returning the same strings for existing callers", () => {
    const spec = raw([
      { path: "a", label: "a", type: "nope" },
      { path: "b", label: "b", type: "string", pattern: "[" },
    ]);

    expect(uiSpecProblems(spec)).toEqual(['fields[0].type: "nope"', "fields[1].pattern"]);
    expect(normalizeUISpec(spec).problems).toEqual(uiSpecProblems(spec));
  });
});
