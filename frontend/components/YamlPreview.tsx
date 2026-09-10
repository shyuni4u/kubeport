"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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

// A refused preview, reduced to what an admin can act on. `detail` is the
// sentence that says what is wrong; the rest of the Problem — `type`,
// `title`, the repeated status — is addressed to a program, and printing the
// whole document buried the one line worth reading (#129).
type PreviewError = { status: number; detail: string; requestId?: string };

async function readPreviewError(res: Response): Promise<PreviewError> {
  try {
    const p = (await res.json()) as { detail?: string; request_id?: string };
    if (typeof p?.detail === "string" && p.detail !== "") {
      return { status: res.status, detail: p.detail, requestId: p.request_id };
    }
  } catch {
    /* not a Problem — an HTML error page from a proxy, or an empty body */
  }
  return { status: res.status, detail: "" };
}

export function YamlPreview({ uiState }: { uiState: UIModeTemplate }) {
  const t = useTranslations("templates.editor.errors");
  const [resources, setResources] = useState("");
  const [uispec, setUISpec] = useState("");
  const [err, setErr] = useState<PreviewError | null>(null);

  const runPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
    try {
      const res = await fetch("/api/v1/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ui_state: state }),
      });
      if (!res.ok) {
        setErr(await readPreviewError(res));
        return;
      }
      const d = await res.json() as { resources_yaml: string; ui_spec_yaml: string };
      setResources(d.resources_yaml);
      setUISpec(d.ui_spec_yaml);
      setErr(null);
    } catch (e) {
      // Never reached the server: no status and no Problem to read.
      setErr({ status: 0, detail: e instanceof Error ? e.message : String(e) });
    }
  }, 300);

  useEffect(() => {
    runPreview(uiState);
  }, [uiState, runPreview]);

  return (
    <div className="space-y-3">
      {err && (
        <div className="text-red-600 text-sm space-y-1">
          <p className="whitespace-pre-wrap break-all">
            {err.detail ? t("preview", { detail: err.detail }) : t("previewNoDetail", { status: err.status })}
          </p>
          {err.requestId && (
            <p className="text-xs text-muted-foreground">
              {t("previewRequestId", { requestId: err.requestId })}
            </p>
          )}
        </div>
      )}
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
