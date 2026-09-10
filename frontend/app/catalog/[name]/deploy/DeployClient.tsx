"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { useDebounce, useDebouncedCallback } from "use-debounce";

import { CLUSTER_CHANGED_EVENT } from "@/components/ClusterPicker";
import { DynamicForm } from "@/components/DynamicForm";
import { HelpHint } from "@/components/HelpHint";
import { RBACCheckPanel, type RbacStatus } from "@/components/RBACCheckPanel";
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
  /**
   * Where a demo session's namespace starts, whatever the cluster says.
   * Computed on the server from DEMO_NAMESPACE, which the chart renders only
   * with demo mode on; undefined for everyone else (#179).
   */
  demoNamespace?: string;
};

type Meta = { name: string; cluster: string; namespace: string };

/**
 * The structured parts of a Problem body this form acts on. `detail` is never
 * shown, so anything the user needs to see has to arrive as a field.
 */
type ProblemBody = {
  title?: unknown;
  conflicts?: Array<{ owner?: unknown; owner_unknown?: unknown }>;
  pinned_namespace?: unknown;
  template_defect?: unknown;
};

function parseProblem(body: string): ProblemBody | null {
  try {
    const p: unknown = JSON.parse(body);
    return p && typeof p === "object" ? (p as ProblemBody) : null;
  } catch {
    return null;
  }
}

/**
 * Who holds the objects behind a `resource-conflict` 409. `owner` is the first
 * release named; `unreadable` is set when an object exists but this account may
 * not read who holds it. Both empty means kubeport did not create what holds
 * them. Null for any other body.
 */
function resourceConflictOf(
  p: ProblemBody | null,
): { owner: string; unreadable: boolean } | null {
  if (p?.title !== "resource-conflict") return null;
  const conflicts = Array.isArray(p.conflicts) ? p.conflicts : [];
  const held = conflicts.find((c) => typeof c?.owner === "string" && c.owner !== "");
  return {
    owner: typeof held?.owner === "string" ? held.owner : "",
    unreadable: conflicts.some((c) => c?.owner_unknown === true),
  };
}

export function DeployClient({
  templateName,
  version,
  team,
  spec,
  updateReleaseId,
  initialValues,
  defaultName = "",
  demoNamespace,
}: Props) {
  const router = useRouter();
  const t = useTranslations("deploy");
  const isUpdate = Boolean(updateReleaseId);

  // Map a failed response to a non-technical, localized message. The raw
  // backend text is preserved only as the Error `cause` (for logs / debugging)
  // and is never shown to the user. The body is read only for structured fields
  // that exist to be shown: the release holding a resource-conflict (#161),
  // where "pick another name" cannot help, and a template object pinned to
  // another namespace (#137) or a ui-spec field type kubeport does not know
  // (#136), where "check your input" blames the one thing that is not wrong. An
  // update gets its own wording, because an existing release cannot move to
  // another area.
  const errorMessageForStatus = useCallback(
    (status: number, body = ""): string => {
      const problem = parseProblem(body);
      if (status === 400 && problem?.pinned_namespace) return t("errors.templateNamespace");
      if (status === 400 && problem?.template_defect) return t("errors.templateDefect");
      if (status === 403) return t("errors.forbidden");
      if (status === 409) {
        const held = resourceConflictOf(problem);
        if (held?.owner) {
          return isUpdate
            ? t("errors.resourceConflictUpdate", { owner: held.owner })
            : t("errors.resourceConflict", { owner: held.owner });
        }
        if (held?.unreadable) return t("errors.resourceConflictUnreadable");
        if (held) {
          return isUpdate
            ? t("errors.resourceConflictUpdateForeign")
            : t("errors.resourceConflictForeign");
        }
        return t("errors.conflict");
      }
      if (status >= 500) return t("errors.server");
      return t("errors.generic");
    },
    [t, isUpdate],
  );

  // Where the namespace field starts (#179): a demo session's own namespace,
  // otherwise the selected cluster's registered default_namespace, otherwise
  // empty — what the chart README promises. It used to be a hard-coded
  // "default", which demo accounts cannot write to, so the demo's main path
  // opened on a permission denial.
  const [meta, setMeta] = useState<Meta>({
    name: defaultName,
    cluster: "",
    namespace: demoNamespace ?? "",
  });
  const [clusters, setClusters] = useState<string[]>([]);
  // Each cluster's registered default_namespace, by name. A ref: only the
  // handlers that pick a cluster read it, and nothing renders from it.
  const clusterNamespaces = useRef<Map<string, string>>(new Map());
  // Set once the reader types in the namespace field. From then on a cluster
  // change leaves it alone — overwriting what someone chose is worse than a
  // suggestion that no longer matches.
  const namespaceTouched = useRef(false);
  const [rendered, setRendered] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /**
   * UX gate only. Authorization is decided by the backend forwarding the
   * user's own token to the k8s API, and k8s RBAC has the final say — never
   * send this value to the server or let it stand in for a server-side check.
   * Its fail-open bias (see RbacStatus) is deliberate for the same reason.
   *
   * Stored with the inputs it was computed for: a verdict about
   * `kube-system` must not gate a submit to `default`.
   */
  const [rbac, setRbac] = useState<{
    cluster: string;
    namespace: string;
    status: RbacStatus;
  }>({ cluster: "", namespace: "", status: "unknown" });
  // Move focus to the error notice when it appears so keyboard / screen
  // reader users land on it instead of hunting below the (long) form.
  const errRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (err) errRef.current?.focus();
  }, [err]);

  // A failure notice describes one attempt with one set of values. The moment
  // the user changes anything it is stale, and leaving it up made a corrected
  // form still look broken (#42).
  const clearErr = useCallback(() => setErr(null), []);

  // Points the form at a cluster, moving the namespace with it while the
  // reader has not chosen one and no demo namespace applies.
  const selectCluster = useCallback(
    (m: Meta, cluster: string): Meta =>
      namespaceTouched.current || demoNamespace
        ? { ...m, cluster }
        : { ...m, cluster, namespace: clusterNamespaces.current.get(cluster) ?? "" },
    [demoNamespace],
  );

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
        const body = (await res.json()) as {
          clusters: Array<{ name: string; default_namespace?: string | null }>;
        };
        const names = body.clusters.map((c) => c.name);
        if (cancelled) return;
        clusterNamespaces.current = new Map(
          body.clusters
            .filter((c) => c.default_namespace)
            .map((c) => [c.name, c.default_namespace as string]),
        );
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
        if (preselect) setMeta((m) => selectCluster(m, preselect));
      } catch {
        // Network/parse failure: clusters stays []. The Select below
        // renders an admin-contact placeholder and blocks submission.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isUpdate, selectCluster]);

  // The sidebar ClusterPicker no longer reloads the page, so follow its
  // choice live (only if the cluster is one we can offer).
  useEffect(() => {
    if (isUpdate) return;
    const onChanged = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (typeof name === "string" && clusters.includes(name)) {
        setMeta((m) => selectCluster(m, name));
      }
    };
    window.addEventListener(CLUSTER_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CLUSTER_CHANGED_EVENT, onChanged);
  }, [isUpdate, clusters, selectCluster]);

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
  // Deduplicated: a template with two Deployments needs one SSAR, not two,
  // and RBACCheckPanel keys its rows by resource name.
  const kinds = useMemo(() => {
    if (!rendered) return [];
    try {
      return [
        ...new Set(
          YAML.parseAllDocuments(rendered)
            .map((d) => (d.toJS() as { kind?: string } | null)?.kind)
            .filter((k): k is string => !!k),
        ),
      ];
    } catch {
      return [];
    }
  }, [rendered]);

  // Every keystroke in the form both refreshes the preview and invalidates
  // any standing failure notice. Stable identity matters: DynamicForm
  // re-subscribes its RHF watcher whenever onChange changes.
  const handleValuesChange = useCallback(
    (values: Record<string, unknown>) => {
      clearErr();
      preview(values);
    },
    [clearErr, preview],
  );

  // Debounced, because the preflight now drives the submit button: without
  // it every keystroke in the namespace field fires one SSAR per kind and
  // the button + red notice flicker between "unknown" and "denied".
  const [debouncedNamespace] = useDebounce(meta.namespace, 300);

  const rbacPanelVisible = Boolean(meta.cluster) && Boolean(debouncedNamespace);
  const handleRbacResult = useCallback(
    (status: RbacStatus) => {
      setRbac({ cluster: meta.cluster, namespace: debouncedNamespace, status });
    },
    [meta.cluster, debouncedNamespace],
  );
  // Blocking requires a denial that was issued for exactly these inputs, so
  // no reset is needed when the panel is hidden or its target changes.
  const rbacBlocked =
    rbacPanelVisible &&
    rbac.status === "denied" &&
    rbac.cluster === meta.cluster &&
    rbac.namespace === debouncedNamespace;

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
            const text = await r.text();
            throw new Error(errorMessageForStatus(r.status, text), { cause: text });
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
            const text = await r.text();
            throw new Error(errorMessageForStatus(r.status, text), { cause: text });
          }
          const body = (await r.json()) as { id: string };
          router.push(`/releases/${body.id}`);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        // Released only on failure. `router.push` returns immediately and the
        // RSC transition takes hundreds of ms, during which this form is still
        // mounted — unlocking here would hand the user a second POST and a
        // 409 "이미 있습니다", which is the very symptom #31 is about.
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
                onChange={(e) => {
                  clearErr();
                  setMeta({ ...meta, name: e.target.value });
                }}
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
                  clearErr();
                  setMeta((m) => selectCluster(m, next));
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
                required
                onChange={(e) => {
                  clearErr();
                  namespaceTouched.current = true;
                  setMeta({ ...meta, namespace: e.target.value });
                }}
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
            submitting ||
            rbacBlocked ||
            // The namespace can now start empty (#179), and the API requires one.
            (!isUpdate && (!meta.cluster || !meta.name.trim() || !meta.namespace.trim()))
          }
          onChange={handleValuesChange}
          onSubmit={submit}
        />
        {rbacBlocked && (
          // Right-aligned under the button it explains (#112). The submit sits
          // at the right edge of the form (`justify-end` in DynamicForm) while
          // this ran the full width from the left margin, so the reviewer
          // measured them 584px apart on one line of sight: the button read as
          // "disabled for no stated reason" and the sentence as an unrelated
          // notice. Nothing about the wording changes — only where it sits.
          <div className="mt-2 flex justify-end">
            <p role="status" className="max-w-sm text-right text-sm text-red-700">
              {t("blockedByRbac")}
            </p>
          </div>
        )}
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
        {rbacPanelVisible && (
          <RBACCheckPanel
            cluster={meta.cluster}
            namespace={debouncedNamespace}
            kinds={kinds}
            onResult={handleRbacResult}
          />
        )}
      </aside>
    </div>
  );
}
