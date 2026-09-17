"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

// Fired on window with `detail` = cluster name whenever the sidebar picker
// changes; `localStorage.kbp_cluster` is already updated by then.
export const CLUSTER_CHANGED_EVENT = "kbp:cluster-changed";

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
    // Re-render server components without a full page reload — a reload
    // would wipe any in-progress form/editor state. Mounted client forms
    // (DeployClient) subscribe to this event to pick up the new choice.
    window.dispatchEvent(new CustomEvent(CLUSTER_CHANGED_EVENT, { detail: name }));
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
      <Label
        htmlFor="kbp-cluster"
        className="mb-2"
      >
        {t("currentCluster")}
      </Label>
      <NativeSelect
        id="kbp-cluster"
        value={current}
        onChange={(e) => pick(e.target.value)}
      >
        {clusters.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
