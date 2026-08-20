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
import { BottomBar } from "@/components/editor/BottomBar";
import { YamlEditor } from "@/components/YamlEditor";
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

  function switchMode(next: string) {
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
      {mode === "yaml" ? <YamlModeEdit /> : <UIModeEdit />}
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

function UIModeEdit() {
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
          setErr(`메타 저장 실패 ${patchRes.status}: ${await patchRes.text()}`);
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
      if (!res.ok) { setErr(`${res.status}: ${await res.text()}`); return; }
      router.push(`/templates/${name}`);
    } finally {
      setSaving(false);
    }
  }

  if (err) return <div className="text-red-600 text-sm">{err}</div>;
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
                onSelect={(p, n) => setActive({ resIdx: i, path: p, node: n })}
                fields={r.fields as Record<string, { mode: "fixed" | "exposed" }>}
              />
            ) : (
              <div className="text-xs text-muted-foreground">
                스키마 로딩 중… ({cluster ? `클러스터 ${cluster}` : "클러스터 미선택"})
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const inspector = active ? (
    <FieldInspector
      path={active.path}
      node={active.node}
      value={state.resources[active.resIdx].fields[active.path] as UIField | undefined}
      onChange={newVal => setState(prev => prev ? ({
        ...prev,
        resources: prev.resources.map((r, i) => i === active.resIdx
          ? { ...r, fields: { ...r.fields, [active.path]: newVal as unknown } }
          : r
        ),
      }) : prev)}
      onClear={() => setState(prev => prev ? ({
        ...prev,
        resources: prev.resources.map((r, i) => {
          if (i !== active.resIdx) return r;
          const { [active.path]: _, ...rest } = r.fields;
          return { ...r, fields: rest };
        }),
      }) : prev)}
    />
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
      <MetaRow meta={meta} onChange={setMeta} nameLocked hideTeam />
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
      <EditorLayout tree={tree} inspector={inspector} preview={preview} />
      {err && <div className="text-red-600 text-sm mt-2">{err}</div>}
      <BottomBar
        canSave={canSave}
        canPublish={canPublish}
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
function YamlModeEdit() {
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
      const res = await fetch(`/api/v1/templates/${name}/versions/${v}`);
      if (!res.ok) { setErr(await res.text()); return; }
      const ver = await res.json() as { resources_yaml?: string; ui_spec_yaml?: string; status?: string; authoring_mode?: string };
      setResourcesYaml(ver.resources_yaml ?? "");
      setUispecYaml(ver.ui_spec_yaml ?? "");
      setStatus(ver.status ?? "");
      setSourceAuthoringMode(ver.authoring_mode ?? "");
      setLoaded(true);
    })();
  }, [name, v]);

  const isDraft = status === "draft";
  // UI-authored drafts can't be PATCHed with yaml payloads — the backend
  // rejects the shape and blocks authoring_mode flips on drafts anyway. Gate
  // save to preview-only in that case, mirroring UIModeEdit's isYamlDraft.
  const isUiDraft = isDraft && sourceAuthoringMode === "ui";
  const canSave = loaded && !saving && !isUiDraft;

  async function save() {
    setErr(null);
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
      if (!res.ok) { setErr(`${res.status}: ${await res.text()}`); return; }
      router.push(`/templates/${name}`);
    } finally {
      setSaving(false);
    }
  }

  if (err && !loaded) return <div className="text-red-600 text-sm">{err}</div>;
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
        <YamlEditor label="resources.yaml" value={resourcesYaml} onChange={setResourcesYaml} />
        <YamlEditor label="ui-spec.yaml" value={uispecYaml} onChange={setUispecYaml} />
      </div>
      <details className="rounded border bg-white p-3" open>
        <summary className="cursor-pointer text-sm font-semibold">{t("userFormPreview")}</summary>
        <div className="mt-3">
          <UserFormPreview uiSpecYaml={uispecYaml} />
        </div>
      </details>
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={!canSave}
          className="px-3 py-1.5 bg-green-600 text-white rounded text-sm disabled:opacity-50"
        >
          {saving ? t("saving") : isDraft ? t("save") : t("saveAsNew")}
        </button>
      </div>
    </div>
  );
}
