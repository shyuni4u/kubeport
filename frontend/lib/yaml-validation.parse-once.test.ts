import { describe, expect, it, vi } from "vitest";

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return { ...actual, parseAllDocuments: vi.fn(actual.parseAllDocuments) };
});

import { parseAllDocuments } from "yaml";

import { resourceKinds, validateTemplateYaml } from "./yaml-validation";

describe("parsing", () => {
  it("parses each text once across the debounced check, the schema kinds and the save re-check", () => {
    const res = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: a }\n";
    const spec = "fields: []\n";
    validateTemplateYaml(res, spec);
    resourceKinds(res);
    validateTemplateYaml(res, spec);
    expect(vi.mocked(parseAllDocuments)).toHaveBeenCalledTimes(2);

    // An edit is a new text, and parses once more.
    validateTemplateYaml(`${res}# edited\n`, spec);
    expect(vi.mocked(parseAllDocuments)).toHaveBeenCalledTimes(3);
  });

  it("does not parse a file over the size limit at all", () => {
    vi.mocked(parseAllDocuments).mockClear();
    const huge = `data:\n${"  k: v\n".repeat(50_000)}`;
    validateTemplateYaml(huge, huge);
    resourceKinds(huge);
    expect(vi.mocked(parseAllDocuments)).not.toHaveBeenCalled();
  });
});
