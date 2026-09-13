import { describe, it, expect } from "vitest";

import { yamlToUIState } from "./yaml-to-ui-state";

// #190 codex review: opening a multi-instance template in the UI editor built a
// state of resources alone, so saving the next version wrote a ui-spec without
// `instances` and the template quietly became single-instance.

const resources = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: conf }\ndata: { a: b }\n";

describe("yamlToUIState instances", () => {
  it("carries instances: multiple into the UI state", () => {
    const { uiState, warnings } = yamlToUIState(resources, "instances: multiple\nfields: []\n");
    expect(uiState.instances).toBe("multiple");
    expect(warnings).toEqual([]);
  });

  it("carries an explicit single too", () => {
    expect(yamlToUIState(resources, "instances: single\nfields: []\n").uiState.instances).toBe("single");
  });

  it("leaves the key out when the ui-spec never set it", () => {
    const { uiState } = yamlToUIState(resources, "fields: []\n");
    expect("instances" in uiState).toBe(false);
  });

  it("warns about a value the backend would refuse instead of dropping it silently", () => {
    const { uiState, warnings } = yamlToUIState(resources, "instances: many\nfields: []\n");
    expect(uiState.instances).toBeUndefined();
    expect(warnings.some((w) => w.includes("instances"))).toBe(true);
  });
});
