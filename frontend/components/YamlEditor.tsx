"use client";

import dynamic from "next/dynamic";

const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

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
    <div className="border rounded bg-white">
      <div className="px-3 py-1.5 text-xs font-mono border-b bg-muted/40">
        {label}
      </div>
      <Monaco
        height="40vh"
        language="yaml"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        options={{ minimap: { enabled: false } }}
      />
    </div>
  );
}
