"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ProblemMessage, type RequestFailure } from "@/components/ProblemMessage";

export function ForceDeleteButton({ releaseId }: { releaseId: string }) {
  const t = useTranslations("releases.stale.forceDelete");
  const tProblem = useTranslations("problem");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestFailure | null>(null);

  async function onClick() {
    if (!window.confirm(t("confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/releases/${releaseId}?force=true`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // The response body used to be printed after "삭제 실패:" as it came —
        // a whole Problem document. It now goes to ProblemMessage, which
        // unfolds it at the viewer's error detail level (#6).
        setError({
          message: t("failed"),
          status: res.status,
          body: await res.text().catch(() => ""),
          at: new Date().toISOString(),
        });
        setBusy(false);
        return;
      }
      router.push("/releases");
    } catch (e) {
      setError({
        message: t("failed"),
        status: 0,
        body: "",
        at: new Date().toISOString(),
      });
      // A request that never got an answer still says what the browser said.
      console.error("force delete:", e);
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
          context={[[tProblem("releaseId"), releaseId]]}
        />
      )}
    </div>
  );
}
