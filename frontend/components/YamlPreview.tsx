"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useDebouncedCallback } from "use-debounce";

import { parseProblemBody } from "@/lib/error-detail";
import { MonacoPanel } from "./MonacoPanel";
import { ProblemMessage, type RequestFailure } from "./ProblemMessage";

export interface UIModeTemplate {
  resources: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    fields: Record<string, unknown>; // UIField values (shape: see FieldInspector.UIField)
  }>;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

// A refused preview, reduced to what an admin can act on. `detail` is the
// sentence that says what is wrong, so it goes into the sentence; the rest of
// the Problem — `type`, `title`, the repeated status — is addressed to a
// program, and printing the whole document buried the one line worth reading
// (#129). The body travels with it for ProblemMessage (#6), which unfolds the
// rest at the viewer's level and keeps the request id copyable.
async function readPreviewError(res: Response, t: Translator): Promise<RequestFailure> {
  const body = await res.text().catch(() => "");
  const detail = parseProblemBody(body)?.detail;
  return {
    message: detail ? t("preview", { detail }) : t("previewNoDetail", { status: res.status }),
    status: res.status,
    body,
    at: new Date().toISOString(),
    omitDetail: Boolean(detail),
  };
}

// A UI-mode template with no resources has nothing to preview, and the server
// cannot say so politely: serializing zero documents is a YAML stream with no
// start, and the answer was go-yaml's own `yaml: expected STREAM-START` under
// "could not build the preview" — on the first screen of a new template, before
// the admin had done anything (#332). So an empty template is never sent.
export function hasNoResources(uiState: UIModeTemplate): boolean {
  return uiState.resources.length === 0;
}

export function YamlPreview({ uiState }: { uiState: UIModeTemplate }) {
  const t = useTranslations("templates.editor.errors");
  const tp = useTranslations("templates.editor.preview");
  const [resources, setResources] = useState("");
  const [uispec, setUISpec] = useState("");
  const [err, setErr] = useState<RequestFailure | null>(null);
  const empty = hasNoResources(uiState);

  const runPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
    try {
      const res = await fetch("/api/v1/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ui_state: state }),
      });
      if (!res.ok) {
        setErr(await readPreviewError(res, t));
        return;
      }
      const d = await res.json() as { resources_yaml: string; ui_spec_yaml: string };
      setResources(d.resources_yaml);
      setUISpec(d.ui_spec_yaml);
      setErr(null);
    } catch (e) {
      // Never reached the server: no status and no Problem to read.
      setErr({
        message: t("preview", { detail: e instanceof Error ? e.message : String(e) }),
        status: 0,
        body: "",
        at: new Date().toISOString(),
      });
    }
  }, 300);

  useEffect(() => {
    // Back to empty also drops a request still waiting out the debounce, so
    // the last resource's preview does not land after it is gone.
    if (empty) {
      runPreview.cancel();
      return;
    }
    runPreview(uiState);
  }, [uiState, empty, runPreview]);

  // Nothing from an earlier preview is shown here — not its YAML, and not an
  // error a request already in flight might still set.
  if (empty) {
    return <p className="text-sm text-muted-foreground">{tp("noResources")}</p>;
  }

  return (
    <div className="space-y-3">
      {err && (
        <ProblemMessage
          message={err.message}
          status={err.status}
          body={err.body}
          at={err.at}
          omitDetail={err.omitDetail}
        />
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
