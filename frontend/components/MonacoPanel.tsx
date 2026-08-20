"use client";

import dynamic from "next/dynamic";

const Editor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false },
);

export type MonacoPanelProps = {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string | undefined) => void;
  language?: "yaml" | "json";
  height?: number | string;
};

export function MonacoPanel({
  value,
  readOnly = false,
  onChange,
  language = "yaml",
  height = "100%",
}: MonacoPanelProps) {
  return (
    <Editor
      value={value}
      language={language}
      height={height}
      theme="vs-dark"
      onChange={onChange}
      options={{
        readOnly,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        tabSize: 2,
      }}
    />
  );
}
