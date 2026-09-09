"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { KindPicker, KindRef } from "@/components/KindPicker";
import { SchemaTree } from "@/components/SchemaTree";
import { FieldInspector, UIField } from "@/components/FieldInspector";
import { YamlPreview, UIModeTemplate } from "@/components/YamlPreview";
import { UserFormPreview } from "@/components/UserFormPreview";
import { EditorLayout } from "@/components/editor/EditorLayout";
import { MetaRow, TemplateMeta } from "@/components/editor/MetaRow";
import { BottomBar } from "@/components/editor/BottomBar";
import { saveErrorMessage } from "@/components/editor/saveError";
import { findUnlabelledExposedField, useBeforeUnloadWhenDirty } from "@/components/editor/useDirtyGuard";
import { YamlEditor } from "@/components/YamlEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { findKindSchema, OpenAPISchemaDoc, SchemaNode } from "@/lib/openapi";

type Team = { id: string; name: string; display_name?: string };

// Sentinel used by the team <Select>. shadcn's Select disallows value="" on
// SelectItem (base-ui rejects empty strings), so the "global" option uses
// this placeholder and is mapped back to "" when submitted.
const GLOBAL_TEAM = "__global__";

function renderTeamLabel(value: unknown, teams: Team[], globalLabel: string): string {
  if (!value || value === GLOBAL_TEAM) return globalLabel;
  const team = teams.find((t) => t.id === value);
  return team?.display_name || team?.name || String(value);
}

interface EditedResource {
  gv: string;
  kind: string;
  name: string;          // metadata.name
  rootSchema: SchemaNode;
  fields: Record<string, UIField>;
}

// useSearchParams requires a Suspense boundary in App Router.
export default function NewTemplatePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <NewTemplatePageInner />
    </Suspense>
  );
}

function LoadingFallback() {
  const t = useTranslations("templates.editor");
  return <div>{t("loading")}</div>;
}

function NewTemplatePageInner() {
  const router = useRouter();
  const t = useTranslations("templates");
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") === "yaml" ? "yaml" : "ui";
  // Switching mode unmounts the inner editor and discards its state, so ask
  // first when there are unsaved edits (and warn on tab close / reload).
  const [dirty, setDirty] = useState(false);
  useBeforeUnloadWhenDirty(dirty, t("editor.leaveLosesEdits"));

  function switchMode(next: string) {
    if (next === mode) return;
    if (dirty && !window.confirm(t("editor.switchModeLosesEdits"))) return;
    setDirty(false);
    const params = new URLSearchParams(searchParams);
    params.set("mode", next);
    router.replace(`/templates/new?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t("editor.newTitle")}</h1>
        <Tabs value={mode} onValueChange={switchMode}>
          <TabsList>
            <TabsTrigger value="ui">{t("editor.uiMode")}</TabsTrigger>
            <TabsTrigger value="yaml">{t("editor.yamlMode")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {mode === "yaml" ? <YamlModeNew onDirty={setDirty} /> : <UIModeNew onDirty={setDirty} />}
    </div>
  );
}

type ModeProps = { onDirty: (dirty: boolean) => void };

function UIModeNew({ onDirty }: ModeProps) {
  const router = useRouter();
  const t = useTranslations("templates.editor");
  const [loaded, setLoaded] = useState(false);
  const [clusters, setClusters] = useState<Array<{ name: string }>>([]);
  const [cluster, setCluster] = useState<string>("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [owningTeamId, setOwningTeamId] = useState<string>("");
  const [resources, setResources] = useState<EditedResource[]>([]);
  const [active, setActive] = useState<{ resIdx: number; path: string; node: SchemaNode } | null>(null);
  const [meta, setMeta] = useState<TemplateMeta>({ name: "", tags: [] });
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [cRes, tRes] = await Promise.all([
          fetch("/api/v1/clusters"),
          fetch("/api/v1/teams"),
        ]);
        if (cRes.ok) {
          const d = await cRes.json() as { clusters: Array<{ name: string }> };
          setClusters(d.clusters);
          const remembered = typeof window !== "undefined"
            ? window.sessionStorage.getItem("kbp:editor-cluster")
            : null;
          const pick = remembered && d.clusters.some((c) => c.name === remembered)
            ? remembered
            : d.clusters[0]?.name;
          if (pick) setCluster(pick);
        }
        if (tRes.ok) {
          const d = await tRes.json() as { teams: Team[] };
          setTeams(d.teams ?? []);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const touch = () => onDirty(true);

  async function addKind(k: KindRef) {
    const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi/${k.gv}`);
    if (!res.ok) { setErr(await res.text()); return; }
    const doc = await res.json() as OpenAPISchemaDoc;
    const schema = findKindSchema(doc, k.group, k.version, k.kind);
    if (!schema) { setErr(t("schemaMissing", { kind: k.kind })); return; }
    setResources(prev => [...prev, {
      gv: k.gv, kind: k.kind,
      name: `${k.kind.toLowerCase()}-${prev.length + 1}`,
      rootSchema: schema,
      fields: {},
    }]);
    touch();
  }

  const uiState: UIModeTemplate = useMemo(() => ({
    resources: resources.map(r => ({
      apiVersion: r.gv.includes("/") ? r.gv : (r.gv === "v1" ? "v1" : r.gv),
      kind: r.kind,
      name: r.name,
      fields: r.fields as unknown as Record<string, unknown>,
    })),
  }), [resources]);

  const canSave = meta.name.trim().length > 0 && resources.length > 0 && !saving;
  // Plan 4 Task 7 scope: Publish is not part of the create flow; a newly
  // created template version always starts as `draft` and is published from
  // the template detail page. We expose the button disabled here so the
  // BottomBar shell stays consistent across editor pages — a later task can
  // chain save+publish.
  const canPublish = false;

  async function saveDraft() {
    setErr(null);
    // Every exposed field needs a label — it's what the end-user sees.
    const unlabelled = findUnlabelledExposedField(resources);
    if (unlabelled) { setErr(t("errors.missingLabel", { path: unlabelled })); return; }
    setSaving(true);
    try {
      // display_name is optional in MetaRow; fall back to the slug so the
      // backend's required field is satisfied when the admin leaves it blank.
      const displayName = meta.display_name?.trim() || meta.name;
      const res = await fetch("/api/v1/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: meta.name,
          display_name: displayName,
          tags: meta.tags,
          authoring_mode: "ui",
          owning_team_id: owningTeamId || undefined,
          ui_state: uiState,
        }),
      });
      if (!res.ok) { setErr(await saveErrorMessage(t, res)); return; }
      onDirty(false);
      // The detail page is where the new draft gets published.
      router.push(`/templates/${meta.name}`);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <div>{t("loading")}</div>;
  if (clusters.length === 0) {
    if (err) return <div className="text-red-600 text-sm whitespace-pre">{err}</div>;
    return <div>{t("noClusters")}</div>;
  }

  const tree = (
    <div className="space-y-4">
      <div>
        <label htmlFor="new-schema-cluster" className="block text-xs mb-1">{t("schemaCluster")}</label>
        <select
          id="new-schema-cluster"
          value={cluster}
          onChange={(e) => {
            setCluster(e.target.value);
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("kbp:editor-cluster", e.target.value);
            }
          }}
          className="border rounded px-2 py-1 w-full"
        >
          {clusters.map(c => <option key={c.name}>{c.name}</option>)}
        </select>
      </div>
      <KindPicker cluster={cluster} onPick={addKind} />
      <hr />
      <div className="space-y-2">
        <h3 className="font-semibold">{t("editingNew")}</h3>
        {resources.map((r, i) => (
          <div key={i} className="border rounded p-2">
            <input
              value={r.name}
              aria-label={t("resourceName")}
              onChange={e => {
                setResources(prev => prev.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x));
                touch();
              }}
              className="w-full border-b text-sm font-mono mb-2"
            />
            <div className="text-xs text-muted-foreground mb-2">{r.gv} · {r.kind}</div>
            <SchemaTree
              schema={r.rootSchema}
              selectedPath={active?.resIdx === i ? active.path : null}
              onSelect={(p, n) => setActive({ resIdx: i, path: p, node: n })}
              fields={r.fields}
            />
          </div>
        ))}
      </div>
    </div>
  );

  const inspector = active ? (
    <FieldInspector
      path={active.path}
      node={active.node}
      kind={resources[active.resIdx].kind}
      resourceName={resources[active.resIdx].name}
      value={resources[active.resIdx].fields[active.path]}
      onChange={v => {
        setResources(prev => prev.map((r, i) => i === active.resIdx
          ? { ...r, fields: { ...r.fields, [active.path]: v } }
          : r
        ));
        touch();
      }}
      onClear={() => {
        setResources(prev => prev.map((r, i) => {
          if (i !== active.resIdx) return r;
          const { [active.path]: _, ...rest } = r.fields;
          return { ...r, fields: rest };
        }));
        touch();
      }}
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
        <TabsContent value="yaml"><YamlPreview uiState={uiState} /></TabsContent>
        <TabsContent value="form"><UserFormPreview uiState={uiState} /></TabsContent>
      </Tabs>
    </div>
  );

  return (
    <div className="space-y-3">
      <MetaRow meta={meta} onChange={(m) => { setMeta(m); touch(); }} hideTeam />
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("owningTeam")}</span>
        <Select
          value={owningTeamId === "" ? GLOBAL_TEAM : owningTeamId}
          onValueChange={(v) => { setOwningTeamId(!v || v === GLOBAL_TEAM ? "" : v); touch(); }}
        >
          <SelectTrigger className="w-64">
            <SelectValue>{(v) => renderTeamLabel(v, teams, t("globalTeamOption"))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GLOBAL_TEAM}>{t("globalTeamOption")}</SelectItem>
            {teams.map((tm) => (
              <SelectItem key={tm.id} value={tm.id}>
                {tm.display_name || tm.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {resources.length === 0 && (
        <div className="rounded border-2 border-dashed border-primary/30 bg-accent p-3 text-sm text-accent-foreground">
          <strong>{t("getStartedLead")}</strong>{t("getStarted")}
        </div>
      )}
      <EditorLayout tree={tree} inspector={inspector} preview={preview} />
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      <BottomBar
        canSave={canSave}
        canPublish={canPublish}
        saving={saving}
        publishing={publishing}
        onSave={saveDraft}
        onPublish={() => setPublishing(false)}
      />
    </div>
  );
}

// ?mode=yaml fallback: mirrors the legacy YAML flow from
// /templates/[name]/edit (used when name === "new"), kept inline here so the
// UI-mode refactor doesn't regress the YAML creation path.
const STARTER_RESOURCES = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: app
          image: nginx:1.25
          ports: [{ containerPort: 80 }]
`;

const STARTER_UISPEC = `fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
`;

function YamlModeNew({ onDirty }: ModeProps) {
  const router = useRouter();
  const t = useTranslations("templates.editor");
  const [meta, setMeta] = useState<TemplateMeta>({ name: "", tags: [] });
  const [teams, setTeams] = useState<Team[]>([]);
  const [owningTeamId, setOwningTeamId] = useState<string>("");
  const [resourcesYaml, setResourcesYaml] = useState(STARTER_RESOURCES);
  const [uispecYaml, setUispecYaml] = useState(STARTER_UISPEC);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const tRes = await fetch("/api/v1/teams");
        if (tRes.ok) {
          const d = await tRes.json() as { teams: Team[] };
          setTeams(d.teams ?? []);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const canSave = meta.name.trim().length > 0 && !saving;
  const touch = () => onDirty(true);

  async function saveDraft() {
    setErr(null);
    setSaving(true);
    try {
      const displayName = meta.display_name?.trim() || meta.name;
      const res = await fetch("/api/v1/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: meta.name,
          display_name: displayName,
          tags: meta.tags,
          authoring_mode: "yaml",
          owning_team_id: owningTeamId || undefined,
          resources_yaml: resourcesYaml,
          ui_spec_yaml: uispecYaml,
        }),
      });
      if (!res.ok) { setErr(await saveErrorMessage(t, res)); return; }
      onDirty(false);
      // The detail page is where the new draft gets published.
      router.push(`/templates/${meta.name}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <MetaRow meta={meta} onChange={(m) => { setMeta(m); touch(); }} hideTeam />
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("owningTeam")}</span>
        <Select
          value={owningTeamId === "" ? GLOBAL_TEAM : owningTeamId}
          onValueChange={(v) => { setOwningTeamId(!v || v === GLOBAL_TEAM ? "" : v); touch(); }}
        >
          <SelectTrigger className="w-64">
            <SelectValue>{(v) => renderTeamLabel(v, teams, t("globalTeamOption"))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={GLOBAL_TEAM}>{t("globalTeamOption")}</SelectItem>
            {teams.map((tm) => (
              <SelectItem key={tm.id} value={tm.id}>
                {tm.display_name || tm.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <YamlEditor label="resources.yaml" value={resourcesYaml} onChange={(v) => { setResourcesYaml(v); touch(); }} />
        <YamlEditor label="ui-spec.yaml" value={uispecYaml} onChange={(v) => { setUispecYaml(v); touch(); }} />
      </div>
      <details className="rounded-md border bg-card p-3" open>
        <summary className="cursor-pointer text-sm font-semibold">{t("userFormPreview")}</summary>
        <div className="mt-3">
          <UserFormPreview uiSpecYaml={uispecYaml} />
        </div>
      </details>
      {err && <div className="text-red-600 text-sm whitespace-pre">{err}</div>}
      <BottomBar
        canSave={canSave}
        canPublish={false}
        saving={saving}
        onSave={saveDraft}
        onPublish={() => {}}
      />
    </div>
  );
}
