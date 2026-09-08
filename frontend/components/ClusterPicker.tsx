"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function ClusterPicker() {
  const t = useTranslations("shell");
  const router = useRouter();
  const [clusters, setClusters] = useState<{ name: string }[]>([]);
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    fetch("/api/v1/clusters")
      .then((r) => r.json())
      .then((d) => {
        setClusters(d.clusters ?? []);
        const stored =
          localStorage.getItem("kbp_cluster") ?? d.clusters?.[0]?.name ?? "";
        setCurrent(stored);
      })
      .catch(() => {});
  }, []);

  function pick(name: string) {
    setCurrent(name);
    localStorage.setItem("kbp_cluster", name);
    // Re-render server components for the new cluster without a full page
    // reload — a reload would wipe any in-progress form/editor state.
    router.refresh();
  }

  if (clusters.length === 0) {
    return (
      <p className="px-1 py-1.5 text-xs text-muted-foreground">
        {t("noClusters")}
      </p>
    );
  }

  return (
    <div>
      <label
        htmlFor="kbp-cluster"
        className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t("currentCluster")}
      </label>
      <select
        id="kbp-cluster"
        value={current}
        onChange={(e) => pick(e.target.value)}
        className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
      >
        {clusters.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
