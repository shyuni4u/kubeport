"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SchemaTree } from "@/components/SchemaTree";
import { FieldInspector, UIField } from "@/components/FieldInspector";
import { YamlPreview, UIModeTemplate } from "@/components/YamlPreview";
import { UserFormPreview } from "@/components/UserFormPreview";
import { EditorLayout } from "@/components/editor/EditorLayout";
import { MetaRow, TemplateMeta } from "@/components/editor/MetaRow";
import { BottomBar, UnsavedChangesStatus } from "@/components/editor/BottomBar";
import { saveErrorMessage } from "@/components/editor/saveError";
import { findUnlabelledExposedField, stableStringify, useBeforeUnloadWhenDirty, useDirtyAgainstBaseline } from "@/components/editor/useDirtyGuard";
import { YamlEditor } from "@/components/YamlEditor";
import { useTemplateYamlValidation } from "@/components/editor/useTemplateYamlValidation";
import { YamlIssueList, useSaveBlockedReason } from "@/components/editor/YamlIssues";
import { validateTemplateYaml } from "@/lib/yaml-validation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { findKindSchema, OpenAPISchemaDoc, SchemaNode } from "@/lib/openapi";
import { yamlToUIState } from "@/lib/yaml-to-ui-state";

// Next.js App Router requires useSearchParams callers to be wrapped in Suspense.
export default function EditUITemplateVersion() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <EditUITemplateVersionInner />
    </Suspense>
  );
}

function LoadingFallback() {
  const t = useTranslations("templates.editor");
  return <div>{t("loading")}</div>;
}

function EditUITemplateVersionInner() {
  const router = useRouter();
  const t = useTranslations("templates.editor");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") === "yaml" ? "yaml" : "ui";
  // Switching mode unmounts the inner editor and discards its state, so ask
  // first when there are unsaved edits (and warn on tab close / reload).
  const [dirty, setDirty] = useState(false);
  useBeforeUnloadWhenDirty(dirty, t("leaveLosesEdits"));

  function switchMode(next: string) {
    if (next === mode) return;
    if (dirty && !window.confirm(t("switchModeLosesEdits"))) return;
    setDirty(false);
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
    router.replace(`${pathname}?${params.toString()}`);
  }

  // The tabs are always rendered so the user can pick a different authoring
  // mode for a new version (e.g. jumping from a legacy yaml-authored latest
  // into UI mode). For drafts the inner component enforces its own
  // authoring_mode check — the backend rejects PATCHes that would flip
  // authoring_mode, so a user who switches tabs while editing a draft sees
  // an informative error instead of silently corrupting the draft.
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Tabs value={mode} onValueChange={switchMode}>
          <TabsList>
            <TabsTrigger value="ui">{t("uiMode")}</TabsTrigger>
            <TabsTrigger value="yaml">{t("yamlMode")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {mode === "yaml" ? (
        <YamlModeEdit dirty={dirty} onDirty={setDirty} />
      ) : (
        <UIModeEdit dirty={dirty} onDirty={setDirty} />
      )}
    </div>
  );
}

type TemplateMetaFromAPI = {
  name: string;
  display_name: string;
  tags?: string[] | null;
};

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// `dirty` comes back down so each mode's BottomBar can show it (#146).
type ModeProps = { dirty: boolean; onDirty: (dirty: boolean) => void };

function UIModeEdit({ dirty, onDirty }: ModeProps) {
  const { name, v } = useParams<{ name: string; v: string }>();
  const router = useRouter();
  const t = useTranslations("templates.editor");
  const [state, setState] = useState<UIModeTemplate | null>(null);
  const [sourceStatus, setSourceStatus] = useState<string>("");
  const [sourceAuthoringMode, setSourceAuthoringMode] = useState<string>("");
  const [convertWarnings, setConvertWarnings] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<Record<string, SchemaNode>>({});
  const [clusters, setClusters] = useState<Array<{ name: string }>>([]);
  const [cluster, setCluster] = useState("");
  const [active, setActive] = useState<{ resIdx: number; path: string; node: SchemaNode } | null>(null);
  // Counts selections rather than tracking which field is selected: on a narrow
  // viewport the layout uses it to surface the inspector, and re-picking the
  // field already open still has to take the reader there.
  const [selectionEvent, setSelectionEvent] = useState(0);
  const selectField = (resIdx: number, path: string, node: SchemaNode) => {
    setActive({ resIdx, path, node });
    setSelectionEvent((n) => n + 1);
  };
  const [meta, setMeta] = useState<TemplateMeta>({ name: name ?? "", tags: [] });
  // Snapshot of meta loaded from the server, used to detect what to PATCH on save.
  const [initialMeta, setInitialMeta] = useState<TemplateMeta | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [vRes, tRes, cRes] = await Promise.all([
          fetch(`/api/v1/templates/${name}/versions/${v}`),
          fetch(`/api/v1/templates/${name}`),
          fetch("/api/v1/clusters"),
        ]);
        if (!vRes.ok) { setErr(await vRes.text()); return; }
        const ver = await vRes.json() as {
          authoring_mode: string;
          ui_state_json: UIModeTemplate;
          resources_yaml: string;
          ui_spec_yaml: string;
          status: string;
        };
        setSourceStatus(ver.status);
        setSourceAuthoringMode(ver.authoring_mode);
        if (ver.authoring_mode === "ui") {
          setState(ver.ui_state_json);
        } else {
          // YAML-authored source: best-effort parse resources + ui-spec back
          // into the UI editor's state. Warnings surface anything the
          // converter couldn't represent losslessly — the banner below lets
          // the admin decide whether to accept the conversion or drop back
          // to the YAML tab. Works for both draft and non-draft sources;
          // the save path below picks PATCH vs POST based on `saveAsPatch`
          // so a draft conversion-then-save creates a new UI-mode version
          // (leaving the yaml draft alone — the backend's one-draft limit
          // means the user will need to delete the yaml draft separately).
          const { uiState, warnings } = yamlToUIState(ver.resources_yaml ?? "", ver.ui_spec_yaml ?? "");
          setState(uiState as UIModeTemplate);
          setConvertWarnings(warnings);
        }

        if (tRes.ok) {
          const t = await tRes.json() as TemplateMetaFromAPI;
          const loaded: TemplateMeta = {
            name: t.name,
            display_name: t.display_name,
            tags: t.tags ?? [],
          };
          setMeta(loaded);
          setInitialMeta(loaded);
        }

        if (cRes.ok) {
          const d = await cRes.json() as { clusters: Array<{ name: string }> };
          setClusters(d.clusters);
          // Prefer a previously-chosen cluster (sessionStorage). Otherwise the
          // first entry. The frontend has no way to know which cluster is the
          // "right" one for reading schemas — with multiple clusters
          // registered (including test-generated ones) the ordering is
          // arbitrary, so the admin should pick explicitly via the dropdown.
          const remembered = typeof window !== "undefined"
            ? window.sessionStorage.getItem("kbp:editor-cluster")
            : null;
          const pick = remembered && d.clusters.some((c) => c.name === remembered)
            ? remembered
            : d.clusters[0]?.name;
          if (pick) setCluster(pick);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        // The dirty baseline waits for this, not for `state` alone (#274).
        setLoadDone(true);
      }
    })();
  }, [name, v]);

  useEffect(() => {
    if (!state || !cluster) return;
    (async () => {
      const out: Record<string, SchemaNode> = { ...schemas };
      for (const r of state.resources) {
        const key = `${r.apiVersion}/${r.kind}`;
        if (out[key]) continue;
        const gv = r.apiVersion;
        const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi/${gv}`);
        if (!res.ok) continue;
        const doc = await res.json() as OpenAPISchemaDoc;
        const [group, version] = gv.includes("/") ? gv.split("/") : ["", gv];
        const s = findKindSchema(doc, group, version, r.kind);
        if (s) out[key] = s;
      }
      setSchemas(out);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, cluster]);

  const uiStateSynthetic = useMemo<UIModeTemplate | null>(() => state, [state]);
  const touch = () => onDirty(true);
  // Everything a save sends, so undoing an edit clears the mark (#274). Null
  // until the whole load has settled: the version renders before the
  // template's metadata arrives, and a baseline taken in between would count
  // the loaded metadata as an edit.
  const [loadDone, setLoadDone] = useState(false);
  const snapshot = useMemo(
    () =>
      state && loadDone
        ? stableStringify({
            state,
            meta: { name: meta.name, display_name: meta.display_name ?? "", tags: meta.tags },
          })
        : null,
    [state, loadDone, meta],
  );
  const markSaved = useDirtyAgainstBaseline(snapshot, dirty, onDirty);

  function pickCluster(next: string) {
    setCluster(next);
    setSchemas({}); // invalidate cached schemas from the previous cluster
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("kbp:editor-cluster", next);
    }
  }

  // Save behavior is status-driven:
  //   - draft + ui-authored source → PATCH in place.
  //   - draft + yaml-authored source → save DISABLED. The backend rejects
  //     authoring_mode flips on drafts, and only one draft is allowed per
  //     template, so the correct workflow is "delete the yaml draft, then
  //     + 새 버전 to start a UI draft". A POST here would 409. Preview-only.
  //   - non-draft source (any mode) → POST creates a new draft.
  const isYamlDraft = sourceStatus === "draft" && sourceAuthoringMode !== "ui";
  const saveAsPatch = sourceStatus === "draft" && sourceAuthoringMode === "ui";
  const canSave = !!state && !saving && !isYamlDraft;
  // Publish-from-editor is a later task; the BottomBar shell stays consistent
  // but the button is disabled here. Publishing still happens from the
  // template detail page.
  const canPublish = false;

  async function save() {
    setErr(null);
    if (!state) return;
    // Every exposed field needs a label — it's what the end-user sees.
    const unlabelled = findUnlabelledExposedField(
      state.resources.map((r) => ({ kind: r.kind, name: r.name, fields: r.fields as Record<string, unknown> })),
    );
    if (unlabelled) { setErr(t("errors.missingLabel", { path: unlabelled })); return; }
    setSaving(true);
    try {
      // 1) PATCH parent-template metadata first (only if the user changed it).
      //    Doing this before the version write means the metadata change is
      //    durable even if the version write fails, and a failing PATCH
      //    aborts the save so the user sees the error instead of the version
      //    landing with stale meta.
      const patchBody: Record<string, unknown> = {};
      if (initialMeta) {
        if ((meta.display_name ?? "") !== (initialMeta.display_name ?? "")) {
          patchBody.display_name = meta.display_name ?? "";
        }
        if (!tagsEqual(meta.tags, initialMeta.tags)) {
          patchBody.tags = meta.tags;
        }
      }
      if (Object.keys(patchBody).length > 0) {
        const patchRes = await fetch(`/api/v1/templates/${name}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        if (!patchRes.ok) {
          setErr(t("errors.metaSave", { status: patchRes.status, detail: (await patchRes.text()).trim() }));
          return;
        }
      }

      // 2) Either PATCH the draft in place or POST a new version.
      const req = saveAsPatch
        ? {
            url: `/api/v1/templates/${name}/versions/${v}`,
            method: "PATCH",
            body: { ui_state: state },
          }
        : {
            url: `/api/v1/templates/${name}/versions`,
            method: "POST",
            body: { authoring_mode: "ui", ui_state: state },
          };
      const res = await fetch(req.url, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
      });
      if (!res.ok) { setErr(await saveErrorMessage(t, res)); return; }
      markSaved();
      router.push(`/templates/${name}`);
    } finally {
      setSaving(false);
    }
  }

  if (err && !state) return <div className="text-red-600 text-sm whitespace-pre">{err}</div>;
  if (!state) return <div>{t("loading")}</div>;

  const tree = (
    <div className="space-y-2">
      <h2 className="font-semibold mb-2">{t("editing", { name, version: v })}</h2>
      {clusters.length > 1 && (
        <div>
          <label htmlFor="edit-schema-cluster" className="block text-xs mb-1">{t("schemaCluster")}</label>
          <select
            id="edit-schema-cluster"
            value={cluster}
            onChange={(e) => pickCluster(e.target.value)}
            className="border rounded px-2 py-1 w-full text-sm"
          >
            {clusters.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
      )}
      {state.resources.map((r, i) => {
        const s = schemas[`${r.apiVersion}/${r.kind}`];
        return (
          <div key={i} className="border rounded p-2 mb-2">
            <div className="text-xs text-muted-foreground mb-1">{r.apiVersion} · {r.kind} · {r.name}</div>
            {s ? (
              <SchemaTree
                schema={s}
                selectedPath={active?.resIdx === i ? active.path : null}
                onSelect={(p, n) => selectField(i, p, n)}
                fields={r.fields as Record<string, { mode: "fixed" | "exposed" }>}
              />
            ) : (
              <div className="text-xs text-muted-foreground">
                {cluster ? t("schemaLoading", { cluster }) : t("schemaLoadingNoCluster")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const inspector = active ? (
    <div className="space-y-2">
    {isYamlDraft && (
      // The page-top banner says this too, but it is a screen height away from
      // the inspector on a long draft — the reader editing a field never sees
      // it, and meets a save button that stays off with no reason given (#184).
      <div role="note" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {t("convert.yamlDraftInspector")}{" "}
        <a href={`/templates/${name}/versions/${v}/edit?mode=yaml`} className="underline">
          {t("convert.editInYaml")}
        </a>
      </div>
    )}
    <FieldInspector
      readOnly={isYamlDraft}
      path={active.path}
      node={active.node}
      kind={state.resources[active.resIdx].kind}
      resourceName={state.resources[active.resIdx].name}
      value={state.resources[active.resIdx].fields[active.path] as UIField | undefined}
      onChange={newVal => {
        setState(prev => prev ? ({
          ...prev,
          resources: prev.resources.map((r, i) => i === active.resIdx
            ? { ...r, fields: { ...r.fields, [active.path]: newVal as unknown } }
            : r
          ),
        }) : prev);
        touch();
      }}
      onClear={() => {
        setState(prev => prev ? ({
          ...prev,
          resources: prev.resources.map((r, i) => {
            if (i !== active.resIdx) return r;
            const { [active.path]: _, ...rest } = r.fields;
            return { ...r, fields: rest };
          }),
        }) : prev);
        touch();
      }}
    />
    </div>
  ) : (
    <div className="text-muted-foreground text-sm">{t("pickFieldHint")}</div>
  );

  const preview = (
    <div className="p-3">
      <Tabs defaultValue="yaml">
        <TabsList className="mb-2">
          <TabsTrigger value="yaml">{t("previewYaml")}</TabsTrigger>
          <TabsTrigger value="form">{t("previewForm")}</TabsTrigger>
        </TabsList>
        <TabsContent value="yaml">
          {uiStateSynthetic && <YamlPreview uiState={uiStateSynthetic} />}
        </TabsContent>
        <TabsContent value="form">
          {uiStateSynthetic && <UserFormPreview uiState={uiStateSynthetic} />}
        </TabsContent>
      </Tabs>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Same reason as the inspector's readOnly: nothing here can be saved on a
          YAML draft, and an edit would also arm the leave-page guard (#184). */}
      <MetaRow meta={meta} onChange={(m) => { setMeta(m); touch(); }} nameLocked hideTeam readOnly={isYamlDraft} />
      {sourceAuthoringMode !== "ui" && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
          <div>
            <strong>{t("convert.convertedTitle")}</strong>{" "}
            {isYamlDraft
              ? t("convert.yamlDraftPreview")
              : t("convert.willSaveAsNew")}
          </div>
          {convertWarnings.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">{t("convert.warnings", { count: convertWarnings.length })}</summary>
              <ul className="mt-1 list-disc pl-5 space-y-0.5">
                {convertWarnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
                {convertWarnings.length > 20 && <li>{t("convert.warningsMore", { count: convertWarnings.length - 20 })}</li>}
              </ul>
            </details>
          )}
        </div>
      )}
      <EditorLayout
        tree={tree}
        inspector={inspector}
        preview={preview}
        selectionEvent={selectionEvent}
      />
      {err && <div className="text-red-600 text-sm mt-2 whitespace-pre">{err}</div>}
      <BottomBar
        canSave={canSave}
        canPublish={canPublish}
        dirty={dirty}
        saving={saving}
        onSave={save}
        onPublish={() => {}}
      />
    </div>
  );
}

// YamlModeEdit: full editor for yaml-authored template versions.
// Save behavior depends on the version's status:
//   - draft:  PATCH /v1/templates/:name/versions/:v — edits in place.
//   - non-draft (published/deprecated): POST /v1/templates/:name/versions —
//     creates a new draft version and navigates back to the detail page.
// This is why "+ 새 버전" on the detail page is just a Link (not a
// server-action that pre-creates a draft): the draft only gets persisted
// when the user clicks Save. Going back before saving leaves the DB alone.
function YamlModeEdit({ dirty, onDirty }: ModeProps) {
  const { name, v } = useParams<{ name: string; v: string }>();
  const router = useRouter();
  const t = useTranslations("templates.editor");
  const [resourcesYaml, setResourcesYaml] = useState("");
  const [uispecYaml, setUispecYaml] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sourceAuthoringMode, setSourceAuthoringMode] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/templates/${name}/versions/${v}`);
        if (!res.ok) { setErr(await res.text()); return; }
        const ver = await res.json() as { resources_yaml?: string; ui_spec_yaml?: string; status?: string; authoring_mode?: string };
        setResourcesYaml(ver.resources_yaml ?? "");
        setUispecYaml(ver.ui_spec_yaml ?? "");
        setStatus(ver.status ?? "");
        setSourceAuthoringMode(ver.authoring_mode ?? "");
        setLoaded(true);
      } catch (e) {
        // Network failure: surface it instead of sitting on "loading" forever.
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [name, v]);

  const touch = () => onDirty(true);
  // The two files a save sends, null until the version has loaded, so undoing
  // an edit clears the mark (#274).
  const snapshot = useMemo(
    () => (loaded ? stableStringify([resourcesYaml, uispecYaml]) : null),
    [loaded, resourcesYaml, uispecYaml],
  );
  const markSaved = useDirtyAgainstBaseline(snapshot, dirty, onDirty);

  const isDraft = status === "draft";
  // UI-authored drafts can't be PATCHed with yaml payloads — the backend
  // rejects the shape and blocks authoring_mode flips on drafts anyway. Gate
  // save to preview-only in that case, mirroring UIModeEdit's isYamlDraft.
  const isUiDraft = isDraft && sourceAuthoringMode === "ui";
  // Errors are what the backend's ValidateSpec would refuse, so save stays off
  // with the reason beside it; warnings save and are listed (#181).
  const validation = useTemplateYamlValidation(resourcesYaml, uispecYaml);
  const saveBlockedReason = useSaveBlockedReason();
  const blockedReason = saveBlockedReason(validation);
  const canSave = loaded && !saving && !isUiDraft && !blockedReason;

  async function save() {
    setErr(null);
    // The list below is debounced; check the text actually being sent.
    const now = saveBlockedReason(validateTemplateYaml(resourcesYaml, uispecYaml));
    if (now) { setErr(now); return; }
    setSaving(true);
    try {
      const req = isDraft
        ? {
            url: `/api/v1/templates/${name}/versions/${v}`,
            method: "PATCH",
            body: { resources_yaml: resourcesYaml, ui_spec_yaml: uispecYaml },
          }
        : {
            url: `/api/v1/templates/${name}/versions`,
            method: "POST",
            body: { authoring_mode: "yaml", resources_yaml: resourcesYaml, ui_spec_yaml: uispecYaml },
          };
      const res = await fetch(req.url, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
      });
      if (!res.ok) { setErr(await saveErrorMessage(t, res)); return; }
      markSaved();
      router.push(`/templates/${name}`);
    } finally {
      setSaving(false);
    }
  }

  if (err && !loaded) return <div className="text-red-600 text-sm whitespace-pre">{err}</div>;
  if (!loaded) return <div>{t("loading")}</div>;

  return (
    <div className="space-y-3">
      {isUiDraft && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t("convert.uiDraftPreview")}
        </div>
      )}
      {!isDraft && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("convert.nonDraftYaml", { version: v, status })}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <YamlEditor label="resources.yaml" value={resourcesYaml} issues={validation.resources} onChange={(x) => { setResourcesYaml(x); touch(); }} />
        <YamlEditor label="ui-spec.yaml" value={uispecYaml} issues={validation.uiSpec} onChange={(x) => { setUispecYaml(x); touch(); }} />
      </div>
      <YamlIssueList validation={validation} />
      <details className="rounded-md border bg-card p-3" open>
        <summary className="cursor-pointer text-sm font-semibold">{t("userFormPreview")}</summary>
        <div className="mt-3">
          <UserFormPreview uiSpecYaml={uispecYaml} />
        </div>
      </details>
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      {/*
        Was a hand-rolled bg-green-600 button sitting next to the preview form's
        primary-coloured submit, so the fake action read louder than the real
        one (#44). Same shadcn Button as everywhere else; the preview's submit
        is now outline. Labels stay — "save as new version" is the whole point
        of editing a published version and BottomBar cannot say it.
      */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* The screen #146 was observed on: say edits are pending before the leave prompt does. */}
        <UnsavedChangesStatus dirty={dirty} />
        {/* Same as BottomBar: a save that is off for a reason says so (#181). */}
        {blockedReason && (
          <span id="yaml-save-blocked" className="text-xs text-destructive">{blockedReason}</span>
        )}
        <Button
          onClick={save}
          disabled={!canSave}
          aria-describedby={blockedReason ? "yaml-save-blocked" : undefined}
        >
          {saving ? t("saving") : isDraft ? t("save") : t("saveAsNew")}
        </Button>
      </div>
    </div>
  );
}
