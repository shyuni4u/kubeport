"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusChip, statusChipVariantFromRelease } from "./StatusChip";

type Row = {
  id: string;
  name: string;
  namespace: string;
  cluster_name: string;
  status?: string;
};

export function OperationsDashboard() {
  const t = useTranslations("operations");
  const ts = useTranslations("releases.status");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState(false);
  const [at, setAt] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [attention, setAttention] = useState(false);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(load, 30000);
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/v1/releases?limit=20&offset=${page * 20}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error();
        const list: Row[] = (await res.json()).releases;
        const pending = [...list];
        const result = new Map<string, string>();
        await Promise.all(
          Array.from({ length: Math.min(4, list.length) }, async () => {
            for (let row = pending.shift(); row; row = pending.shift()) {
              try {
                const r = await fetch(`/api/v1/releases/${row.id}`, {
                  signal: controller.signal,
                });
                result.set(
                  row.id,
                  r.ok ? ((await r.json()).status ?? "unknown") : "unavailable",
                );
              } catch {
                result.set(row.id, "unavailable");
              }
            }
          }),
        );
        if (controller.signal.aborted) return;
        setRows(list.map((row) => ({ ...row, status: result.get(row.id) })));
        setAt(new Date().toLocaleTimeString());
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          timer = setTimeout(load, 30000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, page]);
  const needsAttention = (r: Row) =>
    !["healthy", "unknown"].includes(r.status ?? "unknown");
  const visible = rows.filter(
    (r) =>
      `${r.name} ${r.namespace} ${r.cluster_name}`
        .toLowerCase()
        .includes(filter.toLowerCase()) &&
      (!attention || needsAttention(r)),
  );
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <Link className="text-link underline" href="/catalog">
          {t("newDeployment")}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t("scope")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [t("onPage"), rows.length],
          [t("healthy"), rows.filter((r) => r.status === "healthy").length],
          [t("attention"), rows.filter(needsAttention).length],
        ].map(([label, count]) => (
          <div key={label} className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{count}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-sm"
          aria-label={t("filter")}
          placeholder={t("filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={attention}
            onChange={(e) => setAttention(e.target.checked)}
          />
          {t("attentionOnly")}
        </label>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t("refresh")}
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {busy ? t("loading") : t("updated", { at: at || "—" })}
      </p>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3">
          {t("stale")}
        </p>
      )}
      {!busy && !error && rows.length === 0 && (
        <p className="rounded-xl border bg-card p-8">{t("empty")}</p>
      )}
      <ul className="divide-y rounded-xl border bg-card">
        {visible.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 p-4"
          >
            <div className="min-w-0">
              <Link
                className="break-all font-mono font-medium text-link hover:underline"
                href={`/releases/${row.id}`}
              >
                {row.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                {row.cluster_name} / {row.namespace}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <StatusChip
                variant={statusChipVariantFromRelease(row.status ?? "unknown")}
              >
                {row.status === "unavailable"
                  ? t("unavailable")
                  : ts(row.status ?? "unknown")}
              </StatusChip>
              <Link
                className="text-sm text-link underline"
                href={`/releases/${row.id}/logs`}
              >
                {t("logs")}
              </Link>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-3">
        <Button
          variant="outline"
          disabled={page === 0 || busy}
          onClick={() => setPage((p) => p - 1)}
        >
          {t("previous")}
        </Button>
        <Button
          variant="outline"
          disabled={rows.length < 20 || busy}
          onClick={() => setPage((p) => p + 1)}
        >
          {t("next")}
        </Button>
      </div>
      <Link href="/help" className="inline-block text-sm text-link underline">
        {t("help")}
      </Link>
    </section>
  );
}
