"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function ForceDeleteButton({ releaseId }: { releaseId: string }) {
  const t = useTranslations("releases.stale.forceDelete");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (!window.confirm(t("confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/releases/${releaseId}?force=true`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || res.statusText);
      }
      router.push("/releases");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="destructive" size="sm" onClick={onClick} disabled={busy}>
        {t("button")}
      </Button>
      {error && (
        <span className="text-sm text-destructive">
          {t("failed", { error })}
        </span>
      )}
    </div>
  );
}
