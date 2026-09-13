"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ProblemMessage, type RequestFailure } from "@/components/ProblemMessage";

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
  const tProblem = useTranslations("problem");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestFailure | null>(null);

  async function onClick() {
    if (busy) return;
    if (!window.confirm(t("confirm", { name }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/releases/${releaseId}`, { method: "DELETE" });
      if (!res.ok) {
        // The sentence is ours; the body goes to ProblemMessage, which unfolds
        // it only as far as the viewer's error detail level asks (#6).
        setError({
          message: res.status === 403 ? t("forbidden") : t("failed"),
          status: res.status,
          body: await res.text().catch(() => ""),
          at: new Date().toISOString(),
        });
        setBusy(false);
        return;
      }
      router.push("/releases");
    } catch {
      setError({ message: t("failed"), status: 0, body: "", at: new Date().toISOString() });
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="destructive" size="sm" onClick={onClick} disabled={busy}>
        {t("button")}
      </Button>
      {error && (
        <ProblemMessage
          message={error.message}
          status={error.status}
          body={error.body}
          at={error.at}
          context={[
            [tProblem("release"), name],
            [tProblem("releaseId"), releaseId],
          ]}
        />
      )}
    </div>
  );
}
