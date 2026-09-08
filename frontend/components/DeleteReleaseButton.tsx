"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// Normal-path delete for the release owner: tears the resources down in the
// cluster and removes the DB record. The admin-only `ForceDeleteButton`
// (stale banner) is the DB-only escape hatch and keeps a distinct label.
export function DeleteReleaseButton({
  releaseId,
  name,
}: {
  releaseId: string;
  name: string;
}) {
  const t = useTranslations("releases.delete");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    if (!window.confirm(t("confirm", { name }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/releases/${releaseId}`, { method: "DELETE" });
      if (!res.ok) {
        // Never surface the response body — it is raw backend / k8s text.
        setError(res.status === 403 ? t("forbidden") : t("failed"));
        setBusy(false);
        return;
      }
      router.push("/releases");
    } catch {
      setError(t("failed"));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="destructive" size="sm" onClick={onClick} disabled={busy}>
        {t("button")}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
