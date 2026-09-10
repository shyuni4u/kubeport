import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePathSegments } from "../template-path";
import { yamlToUIState } from "../yaml-to-ui-state";

// Issue #129 was reported against this exact template: opening the seeded
// `web-app` in UI mode returned 400 with `bad path remainder "/name"`. The
// unit tests use minimal fixtures; this one uses the shipped file, so it fails
// if the seed grows a key shape the grammar still cannot express.
//
// It reads the showcase copies, which showcase.test.ts already asserts are
// byte-identical to the backend originals — so this covers the seeded template
// without the frontend reaching into backend/.
const dir = join(process.cwd(), "lib", "showcase");
const resources = readFileSync(join(dir, "web-app.resources.yaml"), "utf8");
const uiSpec = readFileSync(join(dir, "web-app.ui-spec.yaml"), "utf8");

describe("seeded web-app template in UI mode", () => {
  const { uiState, warnings } = yamlToUIState(resources, uiSpec);

  it("converts without warnings", () => {
    expect(warnings).toEqual([]);
    expect(uiState.resources.length).toBeGreaterThan(0);
  });

  it("emits only paths that parse back", () => {
    // The failure this reproduces is not a throw — it is a path that the
    // generator is happy to produce and the backend parser rejects. Checking
    // every field of the real template is the assertion that matters.
    const bad: string[] = [];
    for (const res of uiState.resources) {
      for (const path of Object.keys(res.fields)) {
        if (parsePathSegments(path) === null) bad.push(`${res.kind}[${res.name}].${path}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("addresses the recommended k8s labels as single keys", () => {
    const all = uiState.resources.flatMap((r) => Object.keys(r.fields));
    expect(all).toContain(`metadata.labels["app.kubernetes.io/name"]`);
    expect(all.some((p) => p.startsWith("metadata.labels.app.kubernetes"))).toBe(false);
  });
});
