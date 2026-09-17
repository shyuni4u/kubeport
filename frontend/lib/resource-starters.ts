import starters from "./resource-starters.json";
import { yamlToUIState } from "./yaml-to-ui-state";
import type { UIField } from "@/components/FieldInspector";

// Use the same scalar-path conversion as imported YAML. Starter values remain
// individually editable and appear in the tree instead of opaque fixed objects.
export function resourceStarterFields(apiVersion: string, kind: string, name: string): Record<string, UIField> {
  const starter = starters.find(s => s.apiVersion === apiVersion && s.kind === kind);
  if (!starter) return {};
  const document = JSON.stringify(starter, (_key, value) => value === "__RESOURCE_NAME__" ? name : value);
  return yamlToUIState(document, "fields: []").uiState.resources[0].fields as Record<string, UIField>;
}
