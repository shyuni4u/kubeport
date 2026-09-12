"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { parse } from "yaml";
import { useDebouncedCallback } from "use-debounce";

import { DynamicForm, type UISpec } from "@/components/DynamicForm";
import { PreviewErrorBoundary } from "@/components/PreviewErrorBoundary";
import { normalizeUISpec } from "@/lib/ui-spec-to-zod";
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
  const remote = isUIStateProps(props);

  // YAML mode is a pure function of the text — derive it instead of mirroring
  // it into state from an effect, which cost an extra render and showed the
  // "loading" placeholder for a frame on every keystroke.
  const yamlText = remote ? null : props.uiSpecYaml;
  const local = useMemo(() => {
    if (yamlText === null) return null;
    try {
      return { spec: parseOrEmpty(yamlText), parseError: null as string | null };
    } catch (e) {
      return { spec: null, parseError: e instanceof Error ? e.message : String(e) };
    }
  }, [yamlText]);

  // UI mode round-trips through the backend, so it genuinely needs state.
  const [fetched, setFetched] = useState<UISpec | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const fetchPreview = useDebouncedCallback(async (state: UIModeTemplate) => {
    try {
      const res = await fetch("/api/v1/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ui_state: state }),
      });
      if (!res.ok) {
        setFetchErr(t("previewFailed", { status: res.status, detail: (await res.text()).trim() }));
        return;
      }
      const d = await res.json() as { ui_spec_yaml: string };
      setFetched(parseOrEmpty(d.ui_spec_yaml));
      setFetchErr(null);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    }
  }, 300);

  const uiState = remote ? props.uiState : null;
  // Serialized so the effect re-runs on content change, not on identity change.
  const uiStateKey = uiState ? JSON.stringify(uiState) : null;
  useEffect(() => {
    if (!uiState) return;
    fetchPreview(uiState);
    // uiState is covered by uiStateKey; depending on the object itself would
    // refire on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiStateKey, fetchPreview]);

  const err = local ? (local.parseError && t("parseFailed", { detail: local.parseError })) : fetchErr;
  const parsed = local ? local.spec : fetched;

  if (err) return <div className="text-sm text-red-600 whitespace-pre">{err}</div>;
  if (!parsed) return <div className="text-sm text-muted-foreground">{t("loading")}</div>;

  // The trust boundary (#164). Everything below — DynamicForm, its widgets,
  // its schema — may assume the UISpec type from here on, which is the point:
  // guarding the schema builder alone still left the widget renderer reading
  // `values.length` off an enum that had none.
  const { spec: uiSpec, dropped, ignored, refused } = normalizeUISpec(parsed);

  // Fields left out are reported, not thrown on, and not silently dropped —
  // otherwise a field the admin just wrote simply fails to appear.
  //
  // Two sentences, because they are two different things. A dropped field is
  // missing from the form below; an ignored setting leaves its field in place.
  // Calling the second "left out" sent the admin looking for a row that was
  // still there, and blamed the type when the pattern was the problem (#197).
  //
  // Muted rather than red: mid-edit is the normal state of a ui-spec, and a
  // warning that fires on the way to every valid field is one the reader
  // learns to ignore. Unparseable YAML is a different thing and stays red.
  //
  // A refused pattern is a third sentence: it is finished, so "until it is
  // complete" would send the admin waiting for nothing. Saving says why.
  const hasIssues = dropped.length > 0 || ignored.length > 0 || refused.length > 0;
  const note = hasIssues && (
    <div className="mb-3 space-y-1 text-xs text-muted-foreground">
      {dropped.length > 0 && <p>{t("skippedFields", { fields: dropped.join(", ") })}</p>}
      {ignored.length > 0 && <p>{t("ignoredSettings", { parts: ignored.join(", ") })}</p>}
      {refused.length > 0 && <p>{t("ignoredPattern", { parts: refused.join(", ") })}</p>}
    </div>
  );

  if (uiSpec.fields.length === 0) {
    // "Nothing exposed yet" is the wrong sentence when fields exist but none
    // of them survived — that reads as "you have not written any", which is
    // exactly the misunderstanding the note prevents.
    if (hasIssues) return <div>{note}</div>;
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
    <PreviewErrorBoundary
      fallback={(message) => (
        <div className="text-sm text-red-600 whitespace-pre-wrap">
          {t("renderFailed", { detail: message })}
        </div>
      )}
    >
      {note}
      <DynamicForm
        spec={uiSpec}
        onSubmit={() => { /* preview only — no submit */ }}
        submitLabel={t("previewSubmit")}
        submitVariant="outline"
        disabled
      />
    </PreviewErrorBoundary>
  );
}

function parseOrEmpty(yamlText: string): UISpec {
  if (!yamlText.trim()) return { fields: [] };
  const parsed = parse(yamlText) as UISpec | null;
  if (!parsed || !Array.isArray(parsed.fields)) return { fields: [] };
  return parsed;
}
