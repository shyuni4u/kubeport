"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { parseIndex, OpenAPIIndex } from "@/lib/openapi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface KindRef {
  group: string;
  version: string;
  kind: string;
  gv: string; // "apps/v1" or "v1"
}

// Popular core kinds we surface in the picker without forcing the admin to dig.
// Users can still select any GroupVersion manually.
const FEATURED: KindRef[] = [
  { group: "apps", version: "v1", gv: "apps/v1", kind: "Deployment" },
  { group: "apps", version: "v1", gv: "apps/v1", kind: "StatefulSet" },
  { group: "",     version: "v1", gv: "v1",      kind: "Service" },
  { group: "",     version: "v1", gv: "v1",      kind: "ConfigMap" },
  { group: "",     version: "v1", gv: "v1",      kind: "Secret" },
  { group: "batch", version: "v1", gv: "batch/v1", kind: "Job" },
  { group: "batch", version: "v1", gv: "batch/v1", kind: "CronJob" },
];

// Split a "group/version" (or bare "v1") GroupVersion string into a KindRef's
// group + version fields, matching the convention used by FEATURED entries.
function splitGV(gv: string): { group: string; version: string } {
  if (gv.includes("/")) {
    const [group, version] = gv.split("/");
    return { group, version };
  }
  return { group: "", version: gv };
}

export function KindPicker({
  cluster, onPick,
}: {
  cluster: string;
  onPick: (k: KindRef) => void;
}) {
  const t = useTranslations("templates.editor.kindPicker");
  const [gvs, setGvs] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // The full GroupVersion list carries no kind, so selecting a gv reveals an
  // inline kind input. On submit we assemble a KindRef and call the SAME
  // onPick contract featured items use — the consumer fetches the gv's
  // openapi doc and resolves the kind schema. No window.prompt.
  const [selectedGv, setSelectedGv] = useState<string | null>(null);
  const [kindInput, setKindInput] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/v1/clusters/${encodeURIComponent(cluster)}/openapi`);
        if (!res.ok) throw new Error(t("indexFetchFailed", { status: res.status }));
        const idx = await res.json() as OpenAPIIndex;
        setGvs(parseIndex(idx));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster]);

  function pickFromGv() {
    if (!selectedGv) return;
    const kind = kindInput.trim();
    if (!kind) return;
    const { group, version } = splitGV(selectedGv);
    onPick({ group, version, gv: selectedGv, kind });
    setSelectedGv(null);
    setKindInput("");
  }

  return (
    <div>
      <h3 className="font-semibold mb-2">{t("quickPick")}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t("starterHelp")}</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {FEATURED.map(k => (
          <Button
            key={k.gv + "/" + k.kind}
            type="button"
            onClick={() => onPick(k)}
            variant="outline"
          >
            {k.kind}
          </Button>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-foreground">{t("allGroupVersions", { count: gvs.length })}</summary>
        <div className="mt-2 max-h-64 overflow-auto text-xs font-mono">
          {err && <div className="text-red-600 dark:text-red-400">{err}</div>}
          {gvs.map(gv => (
            <Button
              key={gv}
              type="button"
              variant="ghost"
              aria-pressed={selectedGv === gv}
              onClick={() => { setSelectedGv(gv); setKindInput(""); }}
              // cn(), not a template literal: `border-primary` and the base's
              // `border-transparent` are the same Tailwind group, so
              // concatenating leaves both in the attribute and emit order
              // decides — painting the transparent one and erasing the
              // selection outline entirely.
              className={cn(
                "w-full justify-start font-mono border-transparent",
                selectedGv === gv && "border-primary bg-selected text-selected-foreground",
              )}
            >
              {gv}
            </Button>
          ))}
        </div>
        {selectedGv && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-muted-foreground">{selectedGv}</span>
            <Input
              value={kindInput}
              onChange={(e) => setKindInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); pickFromGv(); } }}
              placeholder={t("kindPlaceholder")}
              aria-label="Kind"
              className="flex-1"
            />
            <Button
              type="button"
              onClick={pickFromGv}
              disabled={!kindInput.trim()}
              variant="outline"
            >
              {t("add")}
            </Button>
          </div>
        )}
      </details>
    </div>
  );
}
