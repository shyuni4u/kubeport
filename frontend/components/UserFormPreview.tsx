"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { parse } from "yaml";
import { useDebouncedCallback } from "use-debounce";

import { DynamicForm, type UISpec } from "@/components/DynamicForm";
import type { UIModeTemplate } from "@/components/YamlPreview";

// UserFormPreview renders DynamicForm against a template's ui-spec so the
// admin can see exactly what the end-user's deploy form will look like.
// Accepts either:
//   - { uiSpecYaml } — used in YAML mode where the admin is editing the
//     ui-spec text directly; no server round-trip needed.
//   - { uiState }    — used in UI mode; we hit /api/v1/templates/preview to
//     let the backend serialize the editor state into the same ui-spec YAML
//     that the save path produces, so the preview matches production output.
// Submission is a no-op (admin is previewing, not deploying).
type Props = { uiSpecYaml: string } | { uiState: UIModeTemplate };

function isUIStateProps(p: Props): p is { uiState: UIModeTemplate } {
  return "uiState" in p;
}

export function UserFormPreview(props: Props) {
  const t = useTranslations("templates.editor.preview");
  const [uiSpec, setUISpec] = useState<UISpec | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
    try {
      const res = await fetch("/api/v1/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ui_state: state }),
      });
      if (!res.ok) {
        setErr(t("previewFailed", { status: res.status, detail: (await res.text()).trim() }));
        return;
      }
      const d = await res.json() as { ui_spec_yaml: string };
      setUISpec(parseOrEmpty(d.ui_spec_yaml));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, 300);

  useEffect(() => {
    if (isUIStateProps(props)) {
      fetchPreview(props.uiState);
    } else {
      try {
        setUISpec(parseOrEmpty(props.uiSpecYaml));
        setErr(null);
      } catch (e) {
        setErr(t("parseFailed", { detail: e instanceof Error ? e.message : String(e) }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUIStateProps(props) ? JSON.stringify(props.uiState) : (props as { uiSpecYaml: string }).uiSpecYaml]);

  if (err) return <div className="text-sm text-red-600 whitespace-pre">{err}</div>;
  if (!uiSpec) return <div className="text-sm text-muted-foreground">{t("loading")}</div>;
  if (uiSpec.fields.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        {t.rich("noExposed", {
          strong: (chunks) => <strong>{chunks}</strong>,
          code: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      </div>
    );
  }
  return (
    <DynamicForm
      spec={uiSpec}
      onSubmit={() => { /* preview only — no submit */ }}
      submitLabel={t("previewSubmit")}
      disabled
    />
  );
}

function parseOrEmpty(yamlText: string): UISpec {
  if (!yamlText.trim()) return { fields: [] };
  const parsed = parse(yamlText) as UISpec | null;
  if (!parsed || !Array.isArray(parsed.fields)) return { fields: [] };
  return parsed;
}
