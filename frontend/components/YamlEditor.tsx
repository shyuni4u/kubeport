"use client";

import { MonacoPanel } from "./MonacoPanel";

// Thin labelled frame around the one Monaco wrapper. It used to import
// @monaco-editor/react itself and leave `theme` unset, so ?mode=yaml rendered a
// light editor while ?mode=ui rendered vs-dark and switching tabs inverted the
// code panel (#44). Editor options belong in MonacoPanel now — this file is
// only the chrome around it.
export function YamlEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
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
      />
    </div>
  );
}
