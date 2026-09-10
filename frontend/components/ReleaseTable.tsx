"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { StatusChip, statusChipVariantFromRelease } from "@/components/StatusChip";

interface ReleaseRow {
  id: string;
  name: string;
  template_name: string;
  template_version: number;
  namespace: string;
}

/**
 * Statuses worth interrupting the reader for. `healthy` is the expected case
 * and `unknown` means "we could not tell" — badging either would put a chip on
 * most rows, which is what the 상태 column was removed for in Plan 6.
 */
const MARKED = new Set([
  "warning",
  "error",
  "failed",
  "cluster-unreachable",
  "resources-missing",
]);

/**
 * The list itself is a pure DB query — status lives in the cluster, not the
 * database, so it costs one k8s round-trip per release (see Plan 12, the
 * deferred reconciler that would put `observed_status` in a column).
 *
 * So the table renders immediately from the DB and the statuses arrive after,
 * a few at a time. A row whose probe fails or never returns just stays as it
 * is today — the enhancement can fail without taking the list with it.
 */
function useReleaseStatuses(ids: string[]): Record<string, string> {
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  // Join, not the array: a new array identity on every parent render would
  // restart the probes.
  const key = ids.join(",");

  useEffect(() => {
    if (ids.length === 0) return;
    // Aborted on unmount so navigating away mid-probe doesn't leave a column
    // of requests running against the cluster for a page nobody is looking at.
    const controller = new AbortController();
    const queue = [...ids];

    async function worker() {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const res = await fetch(`/api/v1/releases/${id}`, {
            signal: controller.signal,
          });
          if (!res.ok) continue;
          const body = (await res.json()) as { status?: string };
          if (controller.signal.aborted || !body.status) continue;
          const status = body.status;
          setStatuses((prev) => ({ ...prev, [id as string]: status }));
        } catch {
          // Offline, aborted, or a non-JSON body: leave the row unmarked.
          if (controller.signal.aborted) return;
        }
      }
    }

    // Each probe fans out to the cluster on the server, so don't fire the
    // whole page at once.
    const CONCURRENCY = 4;
    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker),
    );

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return statuses;
}

export function ReleaseTable({ rows }: { rows: ReleaseRow[] }) {
  const t = useTranslations("releases.table");
  const tStatus = useTranslations("releases.status");
  const statuses = useReleaseStatuses(rows.map((r) => r.id));

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
        <p>{t("empty")}</p>
        <Link
          href="/catalog"
          className="mt-3 inline-block font-medium text-link hover:underline"
        >
          {t("emptyCta")}
        </Link>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 text-left font-medium">{t("name")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("template")}</th>
            <th className="px-4 py-3 text-left font-medium">{t("namespace")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const status = statuses[r.id];
            const marked = status && MARKED.has(status) ? status : null;
            return (
              <tr key={r.id} className="border-t border-border transition hover:bg-hover">
                {/*
                  The chip sits beside the name rather than in a column of its
                  own: healthy rows then look exactly as they do today, and a
                  broken one is visible without opening it.
                */}
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <Link
                      href={`/releases/${r.id}`}
                      className="font-medium text-link hover:underline"
                    >
                      {r.name}
                    </Link>
                    {marked && (
                      <StatusChip variant={statusChipVariantFromRelease(marked)}>
                        {tStatus(marked)}
                      </StatusChip>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {r.template_name}@v{r.template_version}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {r.namespace}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
