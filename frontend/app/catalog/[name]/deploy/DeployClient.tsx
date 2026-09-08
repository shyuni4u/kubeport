"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { useDebouncedCallback } from "use-debounce";

import { CLUSTER_CHANGED_EVENT } from "@/components/ClusterPicker";
import { DynamicForm } from "@/components/DynamicForm";
import { HelpHint } from "@/components/HelpHint";
import { RBACCheckPanel } from "@/components/RBACCheckPanel";
import { ResourcesPreview } from "@/components/ResourcesPreview";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UISpec } from "@/lib/ui-spec-to-zod";

type Props = {
  templateName: string;
  version: number;
  team: string | null;
  spec: UISpec;
  updateReleaseId?: string;
  initialValues?: Record<string, unknown>;
  /**
   * Pre-filled release name. Computed on the server (demo accounts get a
   * random suffix) so SSR and the first client render agree — deriving it
   * here with Math.random() caused a hydration mismatch.
   */
  defaultName?: string;
};

type Meta = { name: string; cluster: string; namespace: string };

export function DeployClient({
  templateName,
  version,
  team,
  spec,
  updateReleaseId,
  initialValues,
  defaultName = "",
}: Props) {
  const router = useRouter();
  const t = useTranslations("deploy");
  const isUpdate = Boolean(updateReleaseId);

  // Map an HTTP status to a non-technical, localized message. The raw backend
  // text is preserved only as the Error `cause` (for logs / debugging) and is
  // never shown to the user.
  const errorMessageForStatus = useCallback(
    (status: number): string => {
      if (status === 403) return t("errors.forbidden");
      if (status === 409) return t("errors.conflict");
      if (status >= 500) return t("errors.server");
      return t("errors.generic");
    },
    [t],
  );

  const [meta, setMeta] = useState<Meta>({
    name: defaultName,
    cluster: "",
    namespace: "default",
  });
  const [clusters, setClusters] = useState<string[]>([]);
  const [rendered, setRendered] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Move focus to the error notice when it appears so keyboard / screen
  // reader users land on it instead of hunting below the (long) form.
  const errRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (err) errRef.current?.focus();
  }, [err]);

  // Load cluster list and hydrate meta.cluster on mount. Skipped for update
  // flows: cluster is immutable on PUT (backend ignores it) and the meta
  // inputs aren't rendered in update mode.
  //
  // The setState-in-effect rule is correctly appeased here: we're reading
  // from localStorage + the network once on mount, not deriving from
  // props/state. The fetch fires only once per mount.
  useEffect(() => {
    if (isUpdate) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/clusters");
        if (!res.ok) return;
        const body = (await res.json()) as { clusters: Array<{ name: string }> };
        const names = body.clusters.map((c) => c.name);
        if (cancelled) return;
        setClusters(names);

        const cached =
          typeof window !== "undefined"
            ? localStorage.getItem("kbp_cluster")
            : null;
        // Prefer the cached cluster if it's still in the list; otherwise
        // default to the first available cluster so the form is usable
        // without an extra click.
        const preselect =
          cached && names.includes(cached) ? cached : (names[0] ?? "");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (preselect) setMeta((m) => ({ ...m, cluster: preselect }));
      } catch {
        // Network/parse failure: clusters stays []. The Select below
        // renders an admin-contact placeholder and blocks submission.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isUpdate]);

  // The sidebar ClusterPicker no longer reloads the page, so follow its
  // choice live (only if the cluster is one we can offer).
  useEffect(() => {
    if (isUpdate) return;
    const onChanged = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (typeof name === "string" && clusters.includes(name)) {
        setMeta((m) => ({ ...m, cluster: name }));
      }
    };
    window.addEventListener(CLUSTER_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CLUSTER_CHANGED_EVENT, onChanged);
  }, [isUpdate, clusters]);

  // Debounced preview render. 300ms matches the ResourcesPreview ergonomics —
  // fast enough to feel live while a user is typing but not spamming the
  // backend. Errors (400 from missing-required etc.) clear the preview; the
  // form's own validation surfaces the actual problem inline.
  const preview = useDebouncedCallback(
    async (values: Record<string, unknown>) => {
      setPending(true);
      try {
        const res = await fetch(
          `/api/v1/templates/${templateName}/render?version=${version}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values }),
          },
        );
        if (!res.ok) {
          setRendered(null);
          return;
        }
        const body = (await res.json()) as { rendered_yaml: string };
        setRendered(body.rendered_yaml);
      } catch {
        setRendered(null);
      } finally {
        setPending(false);
      }
    },
    300,
  );

  // Kinds extracted from the rendered YAML for RBAC preflight. Deriving from
  // the *rendered* yaml (not the template source) ensures conditionally-
  // included resources are reflected correctly.
  const kinds = useMemo(() => {
    if (!rendered) return [];
    try {
      return YAML.parseAllDocuments(rendered)
        .map((d) => (d.toJS() as { kind?: string } | null)?.kind)
        .filter((k): k is string => !!k);
    } catch {
      return [];
    }
  }, [rendered]);

  const submit = useCallback(
    async (values: Record<string, unknown>) => {
      setSubmitting(true);
      setErr(null);
      try {
        if (updateReleaseId) {
          const r = await fetch(`/api/v1/releases/${updateReleaseId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version, values }),
          });
          if (!r.ok) {
            throw new Error(errorMessageForStatus(r.status), {
              cause: await r.text(),
            });
          }
          router.push(`/releases/${updateReleaseId}`);
        } else {
          const r = await fetch("/api/v1/releases", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              template: templateName,
              version,
              name: meta.name,
              cluster: meta.cluster,
              namespace: meta.namespace,
              values,
            }),
          });
          if (!r.ok) {
            throw new Error(errorMessageForStatus(r.status), {
              cause: await r.text(),
            });
          }
          const body = (await r.json()) as { id: string };
          router.push(`/releases/${body.id}`);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSubmitting(false);
      }
    },
    [updateReleaseId, version, templateName, meta, router, errorMessageForStatus],
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_0.85fr]">
      <div>
        <header className="mb-4">
          <h1 className="text-lg font-semibold">
            {isUpdate ? t("titleUpdate", { version }) : t("titleNew")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {templateName} · v{version}
            {team ? ` · ${t("teamSuffix", { team })}` : ""}
          </p>
        </header>
        {!isUpdate && (
          <div className="mb-4 grid grid-cols-2 gap-3">
            {/*
              HelpHint sits beside each label (not inside it) so the (?)
              button's aria-label doesn't leak into the input's name.
            */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <label htmlFor="deploy-name" className="text-sm font-medium">
                  {t("nameLabel")}
                </label>
                <HelpHint text={t("nameHelp")} />
              </div>
              <Input
                id="deploy-name"
                placeholder={t("namePlaceholder")}
                value={meta.name}
                required
                onChange={(e) => setMeta({ ...meta, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span id="deploy-cluster-label" className="text-sm font-medium">
                  {t("clusterLabel")}
                </span>
                <HelpHint text={t("clusterHelp")} />
              </div>
              <Select
                value={meta.cluster}
                onValueChange={(v) => {
                  const next = v ?? "";
                  setMeta((m) => ({ ...m, cluster: next }));
                  if (
                    next &&
                    typeof window !== "undefined"
                  ) {
                    localStorage.setItem("kbp_cluster", next);
                  }
                }}
              >
                <SelectTrigger
                  aria-labelledby="deploy-cluster-label"
                >
                  <SelectValue
                    placeholder={
                      clusters.length === 0
                        ? t("noClusterPlaceholder")
                        : t("clusterPlaceholder")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {clusters.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <label htmlFor="deploy-namespace" className="text-sm font-medium">
                  {t("namespaceLabel")}
                </label>
                <HelpHint text={t("namespaceHelp")} />
              </div>
              <Input
                id="deploy-namespace"
                placeholder={t("namespacePlaceholder")}
                value={meta.namespace}
                onChange={(e) => setMeta({ ...meta, namespace: e.target.value })}
              />
            </div>
          </div>
        )}
        {!isUpdate && clusters.length === 0 && (
          <div
            role="status"
            className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {t("noClusterWarning")}
          </div>
        )}
        <DynamicForm
          spec={spec}
          initialValues={initialValues}
          submitLabel={
            submitting
              ? t("submitting")
              : isUpdate
                ? t("titleUpdate", { version })
                : t("submit")
          }
          disabled={
            submitting || (!isUpdate && (!meta.cluster || !meta.name.trim()))
          }
          onChange={preview}
          onSubmit={submit}
        />
        {err && (
          <p
            ref={errRef}
            role="alert"
            tabIndex={-1}
            className="mt-2 whitespace-pre-wrap text-sm text-red-700 outline-none"
          >
            {err}
          </p>
        )}
        {submitting && (
          <p className="mt-2 text-sm text-muted-foreground">{t("submitting")}</p>
        )}
      </div>
      <aside className="flex flex-col gap-3">
        <ResourcesPreview renderedYaml={rendered} pending={pending} />
        {meta.cluster && meta.namespace && (
          <RBACCheckPanel
            cluster={meta.cluster}
            namespace={meta.namespace}
            kinds={kinds}
          />
        )}
      </aside>
    </div>
  );
}
