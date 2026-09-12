"use client";

import { useMemo } from "react";

import { MonacoPanel, type MonacoMarker } from "./MonacoPanel";
import { useYamlIssueText } from "./editor/YamlIssues";
import type { YamlIssue } from "@/lib/yaml-validation";

// Thin labelled frame around the one Monaco wrapper. It used to import
// @monaco-editor/react itself and leave `theme` unset, so ?mode=yaml rendered a
// light editor while ?mode=ui rendered vs-dark and switching tabs inverted the
// code panel (#44). Editor options belong in MonacoPanel now — this file is
// only the chrome around it.
export function YamlEditor({
  label,
  value,
  onChange,
  issues,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Problems in this file, underlined in place (#181). */
  issues?: YamlIssue[];
}) {
  const text = useYamlIssueText();
  const markers = useMemo<MonacoMarker[] | undefined>(
    () =>
      issues?.map((i) => ({
        severity: i.severity,
        message: text(i),
        startLineNumber: i.startLine,
        startColumn: i.startCol,
        endLineNumber: i.endLine,
        endColumn: i.endCol,
      })),
    [issues, text],
  );
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="border-b bg-muted px-3 py-1.5 font-mono text-xs">
        {label}
      </div>
      <MonacoPanel
        value={value}
        language="yaml"
        height="40vh"
        onChange={(v) => onChange(v ?? "")}
        markers={markers}
      />
    </div>
  );
}
