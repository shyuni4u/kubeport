"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SchemaNode } from "@/lib/openapi";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
    <ul role="tree" className="text-sm font-mono">
      {renderNode("", schema, 0, expanded, setExpanded, selectedPath, onSelect, fields)}
    </ul>
  );
}

function FieldBadge({ mode }: { mode: "fixed" | "exposed" }) {
  const t = useTranslations("templates.editor.field");
  if (mode === "fixed") {
    return (
      <Badge variant="muted" className="ml-1 h-5 px-1.5 text-[11px]">
        {t("fixedBadge")}
      </Badge>
    );
  }
  return (
    <span className="ml-1 rounded-sm bg-accent px-1 text-[11px] text-primary">
      ● {t("exposedBadge")}
    </span>
  );
}

// Every node is a real <button> so keyboard users can Tab/Enter through the
// tree; the ARIA tree roles let screen readers announce nesting + state.
const NODE_CLASS =
  "cursor-pointer rounded border border-transparent px-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Applied through `cn()`, never concatenated. `border-primary` and the base's
 * `border-transparent` are both plain utilities in the same Tailwind group, so
 * a template literal leaves both in the class attribute and the browser picks
 * by emit order — which paints the transparent one and erases the selection.
 * twMerge is what makes the later value win.
 */
const SELECTED_CLASS = "border-primary bg-selected text-selected-foreground";

function renderNode(
  path: string, node: SchemaNode, depth: number,
  expanded: Set<string>, setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>,
  selectedPath: string | null,
  onSelect: (path: string, node: SchemaNode) => void,
  fields?: Record<string, SchemaFieldMode>,
): React.ReactNode {
  const toggle = (p: string) =>
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      return n;
    });

  if (node.type === "object" && node.properties) {
    return Object.entries(node.properties).map(([name, child]) => {
      const p = path ? `${path}.${name}` : name;
      const isExp = expanded.has(p);
      const hasKids = (child.type === "object" && !!child.properties) || (child.type === "array" && !!child.items);
      const fieldMode = fields?.[p]?.mode;
      return (
        <li key={p} role="none" style={{ paddingLeft: depth * 12 }}>
          <button
            type="button"
            role="treeitem"
            aria-selected={selectedPath === p}
            aria-expanded={hasKids ? isExp : undefined}
            className={cn(NODE_CLASS, selectedPath === p && SELECTED_CLASS)}
            onClick={() => {
              onSelect(p, child);
              if (hasKids) toggle(p);
            }}
          >
            {hasKids ? (isExp ? "▾ " : "▸ ") : "· "}
            {name}
            <span className="text-muted-foreground ml-2">{child.type ?? "?"}</span>
            {fieldMode && <FieldBadge mode={fieldMode} />}
          </button>
          {isExp && (
            <ul role="group">
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
      <li role="none" style={{ paddingLeft: depth * 12 }}>
        <button
          type="button"
          role="treeitem"
          aria-selected={selectedPath === p}
          aria-expanded={isExp}
          className={cn(NODE_CLASS, selectedPath === p && SELECTED_CLASS)}
          onClick={() => {
            onSelect(p, node.items!);
            toggle(p);
          }}
        >
          {isExp ? "▾ " : "▸ "}[0]
          <span className="text-muted-foreground ml-2">{node.items.type ?? "?"}</span>
          {fieldMode && <FieldBadge mode={fieldMode} />}
        </button>
        {isExp && (
          <ul role="group">
            {renderNode(p, node.items, depth + 1, expanded, setExpanded, selectedPath, onSelect, fields)}
          </ul>
        )}
      </li>
    );
  }
  return null;
}
