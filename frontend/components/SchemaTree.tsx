"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SchemaNode } from "@/lib/openapi";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { joinPath, parsePathSegments } from "@/lib/template-path";

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
    <span className="ml-1 rounded-sm bg-accent px-1 text-[11px] text-link">
      ● {t("exposedBadge")}
    </span>
  );
}

// Every node is a real <button> so keyboard users can Tab/Enter through the
// tree; the ARIA tree roles let screen readers announce nesting + state.
const NODE_CLASS =
  "min-h-9 w-full cursor-pointer rounded-[8px] border border-transparent px-2 py-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring";

/**
 * Applied through `cn()`, never concatenated. `border-primary` and the base's
 * `border-transparent` are both plain utilities in the same Tailwind group, so
 * a template literal leaves both in the class attribute and the browser picks
 * by emit order — which paints the transparent one and erases the selection.
 * twMerge is what makes the later value win.
 */
const SELECTED_CLASS = "border-primary bg-selected text-selected-foreground";

function MapEntries({ path, node, selectedPath, onSelect, fields }: {
  path: string; node: SchemaNode; selectedPath: string | null;
  onSelect: (path: string, node: SchemaNode) => void;
  fields?: Record<string, SchemaFieldMode>;
}) {
  const t = useTranslations("templates.editor.field");
  const [key, setKey] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const prefix = parsePathSegments(path) ?? [];
  const existing = Object.keys(fields ?? {}).flatMap(p => {
    const parts = parsePathSegments(p);
    return parts && parts.length > prefix.length && prefix.every((s, i) => parts[i] === s)
      && typeof parts[prefix.length] === "string" ? [parts[prefix.length] as string] : [];
  });
  const keys = [...new Set([...existing, ...added])];
  const child = node.additionalProperties as SchemaNode;
  return <li role="none">
    <p className="px-2 text-xs text-muted-foreground">{t("mapHelp")}</p>
    {keys.map(k => {
      const p = joinPath(path, k)!;
      return <button key={k} type="button" role="treeitem" aria-selected={selectedPath === p}
        className={cn(NODE_CLASS, selectedPath === p && SELECTED_CLASS)} onClick={() => onSelect(p, child)}>
        {k}{" "}<span className="ml-2 text-muted-foreground">{child.type}</span>{" "}
        {fields?.[p] && <FieldBadge mode={fields[p].mode} />}
      </button>;
    })}
    <div className="flex gap-2 p-2">
      <Input aria-label={t("mapKey", { path })} value={key} onChange={e => setKey(e.target.value)} />
      <Button type="button" variant="outline" disabled={!key.trim() || !joinPath(path, key.trim()) || keys.includes(key.trim())}
        onClick={() => { const k = key.trim(); setAdded(prev => [...prev, k]); setKey(""); onSelect(joinPath(path, k)!, child); }}>
        {t("addKey")}
      </Button>
    </div>
  </li>;
}

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

  if (node.type === "object" && typeof node.additionalProperties === "object" &&
    ["string", "integer", "boolean"].includes(node.additionalProperties.type ?? "")) {
    return <MapEntries key={path} path={path} node={node} selectedPath={selectedPath} onSelect={onSelect} fields={fields} />;
  }
  if (node.type === "object" && node.properties) {
    return Object.entries(node.properties).map(([name, child]) => {
      const p = path ? `${path}.${name}` : name;
      const isExp = expanded.has(p);
      const hasKids = (child.type === "object" && (!!child.properties || typeof child.additionalProperties === "object")) || (child.type === "array" && !!child.items);
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
