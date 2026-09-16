import type { SchemaNode } from "./openapi";
import { parsePathSegments } from "./template-path";
import type { UIField } from "@/components/FieldInspector";

export function mapSchemaType(node: SchemaNode) {
  if (node.type === "string") return node.enum?.length ? "enum" : "string";
  if (node.type === "integer") return "integer";
  if (node.type === "boolean") return "boolean";
  return null;
}

export function fieldMatchesSchema(node: SchemaNode, field: UIField): boolean {
  const type = mapSchemaType(node);
  if (!type) return false;
  if (field.mode === "exposed") {
    return type === "string" || type === "enum"
      ? ["string", "enum", "autocomplete"].includes(field.uiSpec.type)
      : field.uiSpec.type === type;
  }
  if (field.fixedValue === undefined) return true;
  if (type === "integer") return Number.isInteger(field.fixedValue);
  return typeof field.fixedValue === (type === "enum" ? "string" : type);
}

// Validate against fetched schemas, without persisting them in ui_state.
export function fieldSchemaProblems(resources: Array<{
  kind: string; name: string; fields: Record<string, unknown>; schema?: SchemaNode;
}>): string[] {
  return resources.flatMap(resource => {
    if (!resource.schema) return [];
    return Object.entries(resource.fields).flatMap(([path, value]) => {
      let node: SchemaNode | undefined = resource.schema;
      const segments = parsePathSegments(path);
      if (!segments) return [];
      for (const segment of segments) {
        node = typeof segment === "number" ? node?.items : node?.properties?.[segment];
      }
      return node && !fieldMatchesSchema(node, value as UIField)
        ? [`${resource.kind}[${resource.name}].${path}`] : [];
    });
  });
}
