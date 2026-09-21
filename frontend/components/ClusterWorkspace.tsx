"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BetaBadge } from "./BetaBadge";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { ProblemMessage, type RequestFailure } from "./ProblemMessage";

type Foundation = {
  namespace: string;
  domain?: string;
  tls_secret?: string;
  max_gi?: number;
};
type Item = {
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
  version?: string;
  status: string;
  details: string[];
  foundation?: Foundation;
  // Eviction is decided in each pod's own namespace (#437). Absent means the
  // cluster did not answer, so the action stays available and Kubernetes RBAC
  // decides — only an explicit false disables it.
  evictable?: boolean;
};
type Section = {
  resource: string;
  items: Item[];
  error?: string;
  truncated?: boolean;
};
type Snapshot = { sections: Section[]; permissions: Record<string, boolean> };
type Cluster = { name: string; default_namespace?: string };
type Command = Record<string, unknown> & { action: string; name: string };

export function ClusterWorkspace({
  area,
  admin,
  demo,
  initialCluster,
}: {
  area: "settings" | "nodes" | "storage" | "network";
  admin: boolean;
  demo: boolean;
  initialCluster?: string;
}) {
  const t = useTranslations("operations");
  const router = useRouter();
  const clusterHref = (name: string, section: typeof area) =>
    `/clusters/${encodeURIComponent(name)}${section === "settings" ? "" : `/${section}`}`;
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [cluster, setCluster] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [diagnosis, setDiagnosis] = useState<{
    connection: string;
    permissions: Record<string, boolean>;
  } | null>(null);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const mutation = useRef(false);
  const [at, setAt] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [review, setReview] = useState<Command | null>(null);
  const [result, setResult] = useState("");
  const [selectedNode, setSelectedNode] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/clusters", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const list: Cluster[] = (await r.json()).clusters;
        if (controller.signal.aborted) return;
        setClusters(list);
        const selected = initialCluster
          ? list.find((c) => c.name === initialCluster)
          : list.find((c) => c.name === localStorage.getItem("kbp_cluster")) ?? list[0];
        if (initialCluster && !selected) {
          setFailure({ message: t("clusterMissing"), status: 404, body: "", at: new Date().toISOString() });
        }
        if (selected) {
          setCluster(selected.name);
          setNamespace(selected.default_namespace || "default");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setFailure({
            message: t("loadFailed"),
            status: 0,
            body: "",
            at: new Date().toISOString(),
          });
      });
    return () => controller.abort();
  }, [t, initialCluster]);

  useEffect(() => {
    if (!cluster || demo || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const base = `/api/v1/clusters/${encodeURIComponent(cluster)}`;
    async function load() {
      if (document.visibilityState === "hidden" || mutation.current) {
        timer = setTimeout(load, 30000);
        return;
      }
      setBusy(true);
      try {
        // The node area has no namespace field and the server ignores one
        // there — eviction is decided per pod (#437) — so do not send a value
        // the screen cannot show.
        const path =
          area === "settings"
            ? `/diagnostics?namespace=${encodeURIComponent(namespace)}`
            : area === "nodes"
              ? "/operations?area=nodes"
              : `/operations?area=${area}&namespace=${encodeURIComponent(namespace)}`;
        const r = await fetch(base + path, { signal: controller.signal });
        if (!r.ok) {
          setFailure({
            message: t("loadFailed"),
            status: r.status,
            body: await r.text(),
            at: new Date().toISOString(),
          });
          return;
        }
        const body = await r.json();
        if (controller.signal.aborted) return;
        if (area === "settings") {
          setDiagnosis(body);
          if (admin) {
            const s = await fetch(base + "/settings", {
              signal: controller.signal,
            });
            if (!s.ok) {
              setFailure({
                message: t("loadFailed"),
                status: s.status,
                body: await s.text(),
                at: new Date().toISOString(),
              });
              return;
            }
            const data = await s.json();
            if (!controller.signal.aborted) setSettings(data);
          }
        } else setSnapshot(body);
        setAt(new Date().toLocaleTimeString());
        setFailure(null);
      } catch {
        if (!controller.signal.aborted)
          setFailure({
            message: t("loadFailed"),
            status: 0,
            body: "",
            at: new Date().toISOString(),
          });
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          if (area !== "settings") timer = setTimeout(load, 30000);
        }
      }
    }
    const debounce = setTimeout(load, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(debounce);
    };
  }, [cluster, namespace, area, demo, admin, refresh, t]);

  const all = snapshot?.sections.flatMap((s) => s.items) ?? [];
  const items = (kind: string) => all.filter((i) => i.kind === kind);
  const can = (action: string) =>
    !demo &&
    !busy &&
    !writing &&
    !failure &&
    Boolean(snapshot?.permissions[action]);
  function chooseCluster(name: string) {
    router.push(clusterHref(name, area));
    setCluster(name);
    setNamespace(
      clusters.find((c) => c.name === name)?.default_namespace || "default",
    );
    setSnapshot(null);
    setSettings(null);
    setDiagnosis(null);
    setReview(null);
    setAt("");
    setSelectedNode("");
  }
  function formCommand(e: FormEvent<HTMLFormElement>, action: string) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    const command: Command = { ...data, action, name: data.name, namespace };
    if (data.size_gi) command.size_gi = Number(data.size_gi);
    if (data.port) command.port = Number(data.port);
    if (action === "attach-pvc")
      command.version = items("Deployment").find(
        (i) => i.name === data.name,
      )?.version;
    if (action.startsWith("publish-")) {
      command.version = items(
        action === "publish-storage" ? "StorageClass" : "IngressClass",
      ).find((i) => i.name === data.name)?.version;
      command.foundation = {
        namespace,
        ...(action === "publish-storage"
          ? { max_gi: Number(data.max_gi) }
          : { domain: data.domain, tls_secret: data.tls_secret }),
      };
    }
    setReview(command);
    setResult("");
  }
  async function submit(command: Command) {
    if (mutation.current) return;
    mutation.current = true;
    setWriting(true);
    setBusy(true);
    setFailure(null);
    setResult("");
    try {
      const res = await fetch(
        `/api/v1/clusters/${encodeURIComponent(cluster)}/operations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      if (!res.ok) {
        setFailure({
          message: t("actionFailed"),
          status: res.status,
          body: await res.text(),
          at: new Date().toISOString(),
        });
        return;
      }
      setReview(null);
      setResult(t("accepted"));
      setRefresh((v) => v + 1);
    } catch {
      setFailure({
        message: t("actionFailed"),
        status: 0,
        body: "",
        at: new Date().toISOString(),
      });
    } finally {
      mutation.current = false;
      setWriting(false);
      setBusy(false);
    }
  }
  async function register(e: FormEvent<HTMLFormElement>, updating = false) {
    e.preventDefault();
    if (mutation.current) return;
    mutation.current = true;
    setWriting(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const r = await fetch(
        updating
          ? `/api/v1/clusters/${encodeURIComponent(cluster)}/settings`
          : "/api/v1/clusters",
        {
          method: updating ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            updating ? { ...data, updated_at: settings?.updated_at } : data,
          ),
        },
      );
      if (!r.ok) {
        setFailure({
          message: t("actionFailed"),
          status: r.status,
          body: await r.text(),
          at: new Date().toISOString(),
        });
        return;
      }
      if (updating) {
        setResult(t("accepted"));
        setRefresh((v) => v + 1);
        return;
      }
      const cl = await r.json();
      setClusters((p) => [...p, cl]);
      chooseCluster(cl.name);
      setNamespace(cl.default_namespace || "default");
      setResult(t("registered"));
    } catch {
      setFailure({
        message: t("actionFailed"),
        status: 0,
        body: "",
        at: new Date().toISOString(),
      });
    } finally {
      mutation.current = false;
      setWriting(false);
      setBusy(false);
    }
  }
  const field = (
    name: string,
    label: string,
    type = "text",
    initial = "",
    required = true,
  ) => (
    <label className="grid gap-1 text-sm">
      {label}
      <Input
        name={name}
        type={type}
        defaultValue={initial}
        required={required}
        min={type === "number" ? 1 : undefined}
      />
    </label>
  );
  const select = (name: string, label: string, choices: Item[]) => (
    <label className="grid gap-1 text-sm">
      {label}
      <NativeSelect name={name} required defaultValue="">
        <option value="" disabled>
          {t("choose")}
        </option>
        {choices.map((i) => (
          <option key={i.name} value={i.name}>
            {i.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t(area)}</h1>
        <BetaBadge />
      </div>
      <p className="text-sm text-muted-foreground">{t("workspaceHelp")}</p>
      {cluster && (
        <nav aria-label={t("clusterNavigation")} className="flex flex-wrap gap-2 rounded-xl border bg-card p-2">
          {(["settings", ...(admin ? ["nodes" as const] : []), "storage", "network"] as const).map((section) => (
            <Link key={section} href={clusterHref(cluster, section)}
              aria-current={area === section ? "page" : undefined}
              aria-disabled={writing || undefined}
              onClick={(event) => { if (writing) event.preventDefault(); }}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${area === section ? "bg-selected text-selected-foreground font-medium" : "hover:bg-hover"}`}>
              {t(section)} <BetaBadge />
            </Link>
          ))}
        </nav>
      )}
      <p className="text-sm text-muted-foreground">{t("roles")}</p>
      {demo && (
        <p role="status" className="rounded-xl border bg-muted p-4">
          {t("demo")}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          {t("cluster")}
          <NativeSelect
            disabled={writing}
            value={cluster}
            onChange={(e) => chooseCluster(e.target.value)}
          >
            <option value="" disabled>{t("choose")}</option>
            {clusters.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </NativeSelect>
        </label>
        {area !== "nodes" && (
          <label className="grid gap-1 text-sm">
            Namespace
            <Input
              disabled={writing}
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                setSnapshot(null);
                setReview(null);
              }}
            />
          </label>
        )}
        <Button
          variant="outline"
          disabled={busy || demo || !cluster}
          onClick={() => setRefresh((v) => v + 1)}
        >
          {t("refresh")}
        </Button>
      </div>
      {at && (
        <p className="text-xs text-muted-foreground">{t("updated", { at })}</p>
      )}
      {busy && <p role="status">{t("loading")}</p>}
      {failure && <ProblemMessage {...failure} />}
      {result && (
        <p role="status" className="rounded border p-3">
          {result}
        </p>
      )}
      {area === "settings" && (
        <>
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <h2 className="font-semibold">{t("connectionGuide")}</h2>
            <p className="text-sm">{t("baremetal")}</p>
            <p className="text-sm">{t("eks")}</p>
            <a
              className="text-sm text-link underline"
              href="https://docs.aws.amazon.com/eks/latest/userguide/authenticate-oidc-identity-provider.html"
              target="_blank"
              rel="noreferrer"
            >
              {t("eksDocs")}
            </a>
          </div>
          {diagnosis && (
            <div className="rounded-xl border bg-card p-4">
              <h2 className="font-semibold">
                {t("diagnostics")}: {t(diagnosis.connection)}
              </h2>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {Object.entries(diagnosis.permissions).map(([key, yes]) => (
                  <li key={key}>
                    {t(`capability.${key}`)}: {t(yes ? "allowed" : "forbidden")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {settings && (
            <details className="rounded-xl border bg-card p-4">
              <summary className="cursor-pointer">
                {t("connectionSettings")}
              </summary>
              <dl className="mt-3 space-y-2">
                {["api_url", "oidc_issuer_url", "default_namespace"].map(
                  (key) => (
                    <div key={key}>
                      <dt className="text-xs text-muted-foreground">{key}</dt>
                      <dd className="break-all font-mono text-sm">
                        {settings[key]}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
              <p className="mt-2 text-sm">
                {t("caConfigured", { value: settings.ca_bundle ? "✓" : "—" })}
              </p>
            </details>
          )}
          {settings && admin && (
            <details className="rounded-xl border bg-card p-4">
              <summary className="cursor-pointer">{t("editSettings")}</summary>
              <form
                key={settings.updated_at}
                onSubmit={(e) => void register(e, true)}
                className="mt-4 grid gap-3 sm:grid-cols-2"
              >
                <p className="text-sm sm:col-span-2">{t("settingsHelp")}</p>
                {field(
                  "display_name",
                  t("displayName"),
                  "text",
                  settings.display_name || "",
                  false,
                )}
                {field(
                  "oidc_issuer_url",
                  "OIDC issuer URL",
                  "url",
                  settings.oidc_issuer_url,
                )}
                {field(
                  "default_namespace",
                  "Namespace",
                  "text",
                  settings.default_namespace || "default",
                )}
                <label className="grid gap-1 text-sm">
                  CA bundle (PEM)
                  <textarea
                    className="min-h-24 w-full rounded-lg border border-input bg-background p-3 font-mono text-sm"
                    name="ca_bundle"
                    required
                    rows={4}
                    defaultValue={settings.ca_bundle}
                  />
                </label>
                <Button type="submit" disabled={busy || writing}>
                  {t("saveSettings")}
                </Button>
              </form>
            </details>
          )}
          {admin && (
            <details className="rounded-xl border bg-card p-4">
              <summary className="cursor-pointer">{t("register")}</summary>
              <form
                onSubmit={(e) => void register(e)}
                className="mt-4 grid gap-3 sm:grid-cols-2"
              >
                <fieldset disabled={demo || busy} className="contents">
                  {field("name", t("name"))}
                  {field("display_name", t("displayName"), "text", "", false)}
                  {field("api_url", "Kubernetes API URL", "url")}
                  {field("oidc_issuer_url", "OIDC issuer URL", "url")}
                  {field("default_namespace", "Namespace", "text", "default")}
                  <label className="grid gap-1 text-sm">
                    CA bundle (PEM)
                    <textarea
                      className="min-h-24 w-full rounded-lg border border-input bg-background p-3 font-mono text-sm"
                      name="ca_bundle"
                      required
                      rows={4}
                    />
                  </label>
                  <Button type="submit">{t("register")}</Button>
                </fieldset>
              </form>
            </details>
          )}
        </>
      )}
      {area === "nodes" && (
        <>
          <p className="rounded-xl border bg-muted p-4 text-sm">
            {t("nodeHelp")}
          </p>
          <label className="grid max-w-sm gap-1 text-sm">
            {t("nodeFilter")}
            <NativeSelect
              value={selectedNode}
              onChange={(e) => setSelectedNode(e.target.value)}
            >
              <option value="">{t("allNodes")}</option>
              {items("Node").map((n) => (
                <option key={n.name}>{n.name}</option>
              ))}
            </NativeSelect>
          </label>
        </>
      )}
      {area === "storage" && (
        <>
          <p className="text-sm">{t("storageHelp")}</p>
          <form
            className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2"
            onSubmit={(e) => formCommand(e, "create-storage-app")}
          >
            <h2 className="font-semibold sm:col-span-2">
              {t("createStorageApp")}
            </h2>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              {t("createStorageAppHelp")}
            </p>
            {field("name", "Deployment " + t("name"))}
            {field("image", t("image"))}
            {select("claim", "PVC", items("PersistentVolumeClaim"))}
            {field("mount_path", t("mountPath"), "text", "/data")}
            <Button type="submit" disabled={!can("create-storage-app")}>
              {t("review")}
            </Button>
          </form>
          <div className="grid gap-4 lg:grid-cols-2">
            <form
              className="grid content-start gap-3 rounded-xl border bg-card p-4"
              onSubmit={(e) => formCommand(e, "create-pvc")}
            >
              <h2 className="font-semibold">{t("createPVC")}</h2>
              {select(
                "class",
                "StorageClass",
                items("StorageClass").filter(
                  (i) => i.foundation?.namespace === namespace,
                ),
              )}
              {field("name", "PVC " + t("name"))}
              {field("size_gi", t("sizeGi"), "number", "1")}
              <Button type="submit" disabled={!can("create-pvc")}>
                {t("review")}
              </Button>
            </form>
            <form
              className="grid content-start gap-3 rounded-xl border bg-card p-4"
              onSubmit={(e) => formCommand(e, "attach-pvc")}
            >
              <h2 className="font-semibold">{t("attachPVC")}</h2>
              <p className="text-sm text-muted-foreground">{t("attachHelp")}</p>
              {select("name", "Deployment", items("Deployment"))}
              {select("claim", "PVC", items("PersistentVolumeClaim"))}
              {field("container", t("container"))}
              {field("mount_path", t("mountPath"), "text", "/data")}
              <Button type="submit" disabled={!can("attach-pvc")}>
                {t("review")}
              </Button>
            </form>
          </div>
        </>
      )}
      {area === "network" && (
        <>
          <p className="text-sm">{t("networkHelp")}</p>
          <form
            className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2"
            onSubmit={(e) => formCommand(e, "create-ingress")}
          >
            <h2 className="font-semibold sm:col-span-2">
              {t("createIngress")}
            </h2>
            {select(
              "class",
              "IngressClass",
              items("IngressClass").filter(
                (i) => i.foundation?.namespace === namespace,
              ),
            )}
            {field("name", "Ingress " + t("name"))}
            {field("host", t("host"))}
            {field("path", t("path"), "text", "/")}
            {select("service", "Service", items("Service"))}
            {field("port", t("port"), "number", "80")}
            <Button type="submit" disabled={!can("create-ingress")}>
              {t("review")}
            </Button>
          </form>
        </>
      )}
      {admin && (area === "storage" || area === "network") && (
        <details className="rounded-xl border bg-card p-4">
          <summary className="cursor-pointer">{t("publishFoundation")}</summary>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) =>
              formCommand(
                e,
                area === "storage" ? "publish-storage" : "publish-ingress",
              )
            }
          >
            <p className="text-sm sm:col-span-2">
              {t("foundationHelp", { namespace })}
            </p>
            {select(
              "name",
              area === "storage" ? "StorageClass" : "IngressClass",
              items(area === "storage" ? "StorageClass" : "IngressClass"),
            )}
            {area === "storage" ? (
              field("max_gi", t("maxGi"), "number", "10")
            ) : (
              <>
                {field("domain", t("domain"))}
                {field("tls_secret", t("tlsSecret"), "text", "", false)}
              </>
            )}
            <Button
              type="submit"
              disabled={
                !can(area === "storage" ? "publish-storage" : "publish-ingress")
              }
            >
              {t("review")}
            </Button>
          </form>
        </details>
      )}
      {review && (
        <section
          aria-label={t("review")}
          className="space-y-3 rounded-xl border-2 border-primary bg-card p-4"
        >
          <h2 className="font-semibold">{t("confirmTitle")}</h2>
          <p>
            {cluster} / {namespace}
          </p>
          <dl className="space-y-1 text-sm">
            {Object.entries(review)
              .filter(([key]) => !["uid", "version"].includes(key))
              .map(([key, value]) => (
                <div key={key} className="flex flex-wrap gap-2">
                  <dt className="font-medium">{key}</dt>
                  <dd className="break-all font-mono">
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </div>
              ))}
          </dl>
          <p className="text-sm">{t("confirmHelp")}</p>
          <div className="flex gap-3">
            <Button
              disabled={busy || writing}
              onClick={() => void submit(review)}
            >
              {t("confirm")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || writing}
              onClick={() => setReview(null)}
            >
              {t("cancel")}
            </Button>
          </div>
        </section>
      )}
      {snapshot?.sections.map((section) => (
        <section key={section.resource} className="space-y-2">
          <h2 className="font-semibold">{section.resource}</h2>
          {section.error ? (
            <p className="rounded border p-3 text-sm">{t(section.error)}</p>
          ) : (
            <>
              {section.truncated && <p role="alert">{t("truncated")}</p>}
              {section.items.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("noResources")}
                </p>
              )}
              <ul className="grid gap-3">
                {section.items
                  .filter(
                    (i) =>
                      !selectedNode ||
                      (i.kind === "Pod"
                        ? i.details.includes("node: " + selectedNode)
                        : ["Node", "NodeMetrics"].includes(i.kind)
                          ? i.name === selectedNode
                          : true),
                  )
                  .map((i) => (
                    <li
                      key={`${i.namespace}/${i.name}`}
                      className="min-w-0 rounded-xl border bg-card p-4"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <h3 className="break-all font-mono font-medium">
                          {i.namespace && i.namespace + "/"}
                          {i.name}
                        </h3>
                        <span className="text-sm">{i.status}</span>
                      </div>
                      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {i.details.map((d, n) => (
                          <li className="break-words" key={n}>
                            {d}
                          </li>
                        ))}
                      </ul>
                      {i.foundation && (
                        <p className="mt-2 break-words text-sm">
                          {t("published")}: {i.foundation.namespace}{" "}
                          {i.foundation.domain}{" "}
                          {i.foundation.max_gi && `${i.foundation.max_gi} Gi`}{" "}
                          {i.foundation.tls_secret &&
                            `TLS: ${i.foundation.tls_secret}`}
                        </p>
                      )}
                      {i.kind === "Node" && (
                        <Button
                          className="mt-3"
                          variant="outline"
                          disabled={!can("cordon")}
                          onClick={() =>
                            setReview({
                              action: i.status.includes("cordoned")
                                ? "uncordon"
                                : "cordon",
                              name: i.name,
                              version: i.version,
                            })
                          }
                        >
                          {i.status.includes("cordoned")
                            ? "Uncordon"
                            : "Cordon"}
                        </Button>
                      )}
                      {i.kind === "Pod" && (
                        <Button
                          className="mt-3"
                          variant="outline"
                          disabled={
                            !can("evict") ||
                            i.evictable === false ||
                            i.details.some((d) =>
                              d.startsWith("eviction: blocked:"),
                            ) ||
                            i.status === "Terminating"
                          }
                          onClick={() =>
                            setReview({
                              action: "evict",
                              name: i.name,
                              namespace: i.namespace,
                              uid: i.uid,
                              node: i.details
                                .find((d) => d.startsWith("node: "))
                                ?.slice(6),
                            })
                          }
                        >
                          {t("evict")}
                        </Button>
                      )}
                      {/* A greyed button with no reason is the confusion this
                          fixes, so say it in the page rather than in a title
                          a disabled control may never show. */}
                      {i.kind === "Pod" && i.evictable === false && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t("evictDenied")}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      ))}
      <Link className="inline-block text-sm text-link underline" href="/help">
        {t("help")}
      </Link>
    </section>
  );
}
