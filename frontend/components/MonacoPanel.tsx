"use client";

import { useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { OnMount } from "@monaco-editor/react";

const Editor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false },
);

/**
 * A problem to underline in the editor. Positions are 1-based and `endColumn`
 * is exclusive, as Monaco takes them. Kept free of Monaco's own types so
 * callers do not import the editor package — this file is its only importer.
 */
export type MonacoMarker = {
  severity: "error" | "warning";
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type MonacoPanelProps = {
  value: string;
  readOnly?: boolean;
  onChange?: (value: string | undefined) => void;
  language?: "yaml" | "json";
  height?: number | string;
  markers?: MonacoMarker[];
};

// One owner for every marker kubeport sets, so each update replaces the last
// set wholesale instead of piling up beside it.
const MARKER_OWNER = "kubeport";

type Mounted = { editor: Parameters<OnMount>[0]; monaco: Parameters<OnMount>[1] };

export function MonacoPanel({
  value,
  readOnly = false,
  onChange,
  language = "yaml",
  height = "100%",
  markers,
}: MonacoPanelProps) {
  // The editor loads after first render (dynamic import), and markers can
  // arrive before or after it does — so both the mount and every change apply
  // whatever the latest list is.
  const mounted = useRef<Mounted | null>(null);
  const latest = useRef<MonacoMarker[] | undefined>(markers);

  const apply = useCallback(() => {
    const m = mounted.current;
    const model = m?.editor.getModel();
    if (!m || !model) return;
    m.monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      (latest.current ?? []).map(({ severity, ...rest }) => ({
        ...rest,
        severity: severity === "error" ? m.monaco.MarkerSeverity.Error : m.monaco.MarkerSeverity.Warning,
      })),
    );
  }, []);

  useEffect(() => {
    latest.current = markers;
    apply();
  }, [markers, apply]);

  const onMount: OnMount = (editor, monaco) => {
    mounted.current = { editor, monaco };
    apply();
  };

  return (
    <Editor
      value={value}
      language={language}
      height={height}
      theme="vs-dark"
      onChange={onChange}
      onMount={onMount}
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
