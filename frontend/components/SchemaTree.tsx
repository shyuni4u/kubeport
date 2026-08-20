"use client";

import { useState } from "react";
import { flattenSchema, SchemaNode } from "@/lib/openapi";
import { Badge } from "@/components/ui/badge";

export type SchemaFieldMode = { mode: "fixed" | "exposed" };

export function SchemaTree({
  schema, selectedPath, onSelect, fields,
}: {
  schema: SchemaNode;
  selectedPath: string | null;
  onSelect: (path: string, node: SchemaNode) => void;
  fields?: Record<string, SchemaFieldMode>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["spec", "metadata"]));
  return (
    <ul className="text-sm font-mono">
      {renderNode("", schema, 0, expanded, setExpanded, selectedPath, onSelect, fields)}
    </ul>
  );
}

function FieldBadge({ mode }: { mode: "fixed" | "exposed" }) {
  if (mode === "fixed") {
    return (
      <Badge variant="muted" className="ml-1 h-4 px-1 text-[9px]">
        고정
      </Badge>
    );
  }
  return (
    <span className="ml-1 rounded-sm bg-accent px-1 text-[9px] text-primary">
      ● exposed
    </span>
  );
}

function renderNode(
  path: string, node: SchemaNode, depth: number,
  expanded: Set<string>, setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>,
  selectedPath: string | null,
  onSelect: (path: string, node: SchemaNode) => void,
  fields?: Record<string, SchemaFieldMode>,
): React.ReactNode {
  if (node.type === "object" && node.properties) {
    return Object.entries(node.properties).map(([name, child]) => {
      const p = path ? `${path}.${name}` : name;
      const isExp = expanded.has(p);
      const hasKids = (child.type === "object" && !!child.properties) || (child.type === "array" && !!child.items);
      const fieldMode = fields?.[p]?.mode;
      return (
        <li key={p} style={{ paddingLeft: depth * 12 }}>
          <span
            className={`cursor-pointer hover:bg-muted px-1 rounded ${selectedPath === p ? "bg-accent" : ""}`}
            onClick={() => {
              onSelect(p, child);
              if (hasKids) {
                setExpanded(prev => {
                  const n = new Set(prev);
                  n.has(p) ? n.delete(p) : n.add(p);
                  return n;
                });
              }
            }}
          >
            {hasKids ? (isExp ? "▾ " : "▸ ") : "· "}
            {name}
            <span className="text-muted-foreground ml-2">{child.type ?? "?"}</span>
            {fieldMode && <FieldBadge mode={fieldMode} />}
          </span>
          {isExp && (
            <ul>
              {renderNode(p, child, depth + 1, expanded, setExpanded, selectedPath, onSelect, fields)}
            </ul>
          )}
        </li>
      );
    });
  }
  if (node.type === "array" && node.items) {
    const p = `${path}[0]`;
    const isExp = expanded.has(p);
    const fieldMode = fields?.[p]?.mode;
    return (
      <li style={{ paddingLeft: depth * 12 }}>
        <span
          className={`cursor-pointer hover:bg-muted px-1 rounded ${selectedPath === p ? "bg-accent" : ""}`}
          onClick={() => {
            onSelect(p, node.items!);
            setExpanded(prev => {
              const n = new Set(prev);
              n.has(p) ? n.delete(p) : n.add(p);
              return n;
            });
          }}
        >
          {isExp ? "▾ " : "▸ "}[0]
          <span className="text-muted-foreground ml-2">{node.items.type ?? "?"}</span>
          {fieldMode && <FieldBadge mode={fieldMode} />}
        </span>
        {isExp && (
          <ul>
            {renderNode(p, node.items, depth + 1, expanded, setExpanded, selectedPath, onSelect, fields)}
          </ul>
        )}
      </li>
    );
  }
  return null;
}
