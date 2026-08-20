import { getTranslations } from "next-intl/server";
import { ServerCrash, AlertTriangle } from "lucide-react";
import { ForceDeleteButton } from "./ForceDeleteButton";

export type StaleStatus = "cluster-unreachable" | "resources-missing";

export async function ReleaseStaleBanner({
  status,
  releaseId,
  cluster,
  isAdmin,
}: {
  status: StaleStatus;
  releaseId: string;
  cluster: string;
  isAdmin: boolean;
}) {
  const t = await getTranslations("releases.stale");
  const Icon = status === "cluster-unreachable" ? ServerCrash : AlertTriangle;
  return (
    <div className="flex gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 space-y-2">
        <p className="font-medium">{t(`title.${status}`)}</p>
        <p className="text-sm text-muted-foreground">
          {t(`body.${status}`, { cluster })}
        </p>
        {isAdmin ? (
          <ForceDeleteButton releaseId={releaseId} />
        ) : (
          <p className="text-sm">{t("contactAdmin")}</p>
        )}
      </div>
    </div>
  );
}
