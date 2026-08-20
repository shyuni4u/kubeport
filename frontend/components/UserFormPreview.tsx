"use client";

import { useEffect, useState } from "react";
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
        setErr(`${res.status}: ${await res.text()}`);
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
        setErr(`ui-spec 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUIStateProps(props) ? JSON.stringify(props.uiState) : (props as { uiSpecYaml: string }).uiSpecYaml]);

  if (err) return <div className="text-sm text-red-600 whitespace-pre">{err}</div>;
  if (!uiSpec) return <div className="text-sm text-muted-foreground">로딩 중…</div>;
  if (uiSpec.fields.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        아직 노출된 필드가 없습니다. UI 모드에서는 트리의 값을 <strong>노출</strong> 로 표시하면 여기 나타납니다. YAML 모드에서는 <code className="font-mono">ui-spec.yaml</code> 의 <code className="font-mono">fields[]</code> 를 추가하세요.
      </div>
    );
  }
  return (
    <DynamicForm
      spec={uiSpec}
      onSubmit={() => { /* preview only — no submit */ }}
      submitLabel="배포 (미리보기 — 실제 동작 X)"
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
