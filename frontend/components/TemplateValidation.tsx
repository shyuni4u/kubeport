"use client";

import { useCallback, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { parse } from "yaml";
import { DynamicForm, type UISpec } from "@/components/DynamicForm";
import { PreviewErrorBoundary } from "@/components/PreviewErrorBoundary";
import { ProblemMessage, type RequestFailure } from "@/components/ProblemMessage";
import type { UIModeTemplate } from "@/components/YamlPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { normalizeUISpec } from "@/lib/ui-spec-to-zod";
import { parseProblemBody } from "@/lib/error-detail";

type Source = { uiState: UIModeTemplate } | { resourcesYaml: string; uiSpecYaml: string };
type Prepared = { resources: string; uiSpec: string; spec: UISpec };

// A changed draft unmounts its previous result and pending requests' state.
export function TemplateValidation(source: Source) {
  return <ValidationPanel key={JSON.stringify(source)} source={source} />;
}

function ValidationPanel({ source }: { source: Source }) {
  const t = useTranslations("templateValidation");
  const id = useId();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [clusters, setClusters] = useState<string[]>([]);
  const [cluster, setCluster] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [name, setName] = useState("validation");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [success, setSuccess] = useState(false);
  const invalidate = useCallback(() => { setSuccess(false); setFailure(null); }, []);

  async function checked(res: Response) {
    if (res.ok) return;
    const body = await res.text();
    const detail = parseProblemBody(body)?.detail;
    setFailure({ message: detail || t("failed"), status: res.status, body, at: new Date().toISOString(), omitDetail: Boolean(detail) });
    throw new Error("response-handled");
  }

  function report(error: unknown) {
    if (error instanceof Error && error.message === "response-handled") return;
    setFailure({ message: error instanceof Error ? error.message : t("failed"), status: 0, body: "", at: new Date().toISOString() });
  }

  async function prepare() {
    setPending(true);
    invalidate();
    try {
      const clusterRes = await fetch("/api/v1/clusters");
      await checked(clusterRes);
      const list = await clusterRes.json() as { clusters: { name: string }[] };
      setClusters(list.clusters.map(c => c.name));
      let resources: string, uiSpec: string;
      if ("uiState" in source) {
        const res = await fetch("/api/v1/templates/preview", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui_state: source.uiState }),
        });
        await checked(res);
        const data = await res.json() as { resources_yaml: string; ui_spec_yaml: string };
        resources = data.resources_yaml;
        uiSpec = data.ui_spec_yaml;
      } else {
        resources = source.resourcesYaml;
        uiSpec = source.uiSpecYaml;
      }
      const normalized = normalizeUISpec(parse(uiSpec));
      if (normalized.problems.length) throw new Error(t("invalidSpec"));
      setPrepared({ resources, uiSpec, spec: normalized.spec });
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  async function validate(values: Record<string, unknown>) {
    if (!prepared || !cluster || !namespace || !name) return;
    setPending(true);
    invalidate();
    try {
      const res = await fetch("/api/v1/templates/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resources_yaml: prepared.resources, ui_spec_yaml: prepared.uiSpec, values, cluster, namespace, name }),
      });
      await checked(res);
      const result = await res.json() as { valid?: boolean };
      if (result.valid !== true) throw new Error(t("failed"));
      setSuccess(true);
    } catch (error) { report(error); }
    finally { setPending(false); }
  }

  return <section className="space-y-3 rounded-xl border bg-card p-4" aria-label={t("title")}>
    <h2 className="text-sm font-semibold">{t("title")}</h2>
    <p className="text-sm text-muted-foreground">{t("help")}</p>
    {!prepared ? <Button type="button" variant="outline" disabled={pending} onClick={prepare}>{pending ? t("loading") : t("prepare")}</Button> : <>
      <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2"><Label htmlFor={`${id}-cluster`}>{t("cluster")}</Label><NativeSelect id={`${id}-cluster`} value={cluster} onChange={e => { setCluster(e.target.value); invalidate(); }}>
          <option value="">{t("chooseCluster")}</option>
          {clusters.map(c => <option key={c} value={c}>{c}</option>)}
        </NativeSelect></div>
        <div className="space-y-2"><Label htmlFor={`${id}-namespace`}>{t("namespace")}</Label><Input id={`${id}-namespace`} value={namespace} onChange={e => { setNamespace(e.target.value); invalidate(); }} /></div>
        <div className="space-y-2"><Label htmlFor={`${id}-name`}>{t("name")}</Label><Input id={`${id}-name`} value={name} onChange={e => { setName(e.target.value); invalidate(); }} /></div>
      </fieldset>
      <PreviewErrorBoundary fallback={() => <p role="alert">{t("invalidSpec")}</p>}>
        <DynamicForm spec={prepared.spec} onSubmit={validate} onChange={invalidate} disabled={pending || !cluster || !namespace || !name} submitLabel={pending ? t("running") : t("run")} submitVariant="outline" />
      </PreviewErrorBoundary>
    </>}
    {failure && <ProblemMessage {...failure} />}
    {success && <p role="status" className="text-sm text-foreground">{t("success", { cluster, namespace })}</p>}
  </section>;
}
