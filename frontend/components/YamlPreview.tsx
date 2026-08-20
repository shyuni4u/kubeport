"use client";

import { useEffect, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { MonacoPanel } from "./MonacoPanel";

export interface UIModeTemplate {
  resources: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    fields: Record<string, unknown>; // UIField values (shape: see FieldInspector.UIField)
  }>;
}

export function YamlPreview({ uiState }: { uiState: UIModeTemplate }) {
  const [resources, setResources] = useState("");
  const [uispec, setUISpec] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const runPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
    try {
      const res = await fetch("/api/v1/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ui_state: state }),
      });
      if (!res.ok) {
        setErr(`${res.status}: ${await res.text()}`);
        return;
      }
      const d = await res.json() as { resources_yaml: string; ui_spec_yaml: string };
      setResources(d.resources_yaml);
      setUISpec(d.ui_spec_yaml);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, 300);

  useEffect(() => {
    runPreview(uiState);
  }, [uiState, runPreview]);

  return (
    <div className="space-y-3">
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground mb-1">resources.yaml</h3>
        <MonacoPanel value={resources} readOnly language="yaml" height={240} />
      </div>
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground mb-1">ui-spec.yaml</h3>
        <MonacoPanel value={uispec} readOnly language="yaml" height={160} />
      </div>
    </div>
  );
}
