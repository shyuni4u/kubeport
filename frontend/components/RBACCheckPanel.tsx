"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type Props = {
  cluster: string;
  namespace: string;
  kinds: string[];
};

type CheckResult = {
  allowed: boolean;
  resource: string;
  reason: string;
  // When the check itself failed (network / non-2xx), we surface a distinct
  // "check failed" message instead of an RBAC-deny message.
  httpStatus?: number;
};

const KIND_TO_RESOURCE: Record<string, { group: string; resource: string }> = {
  Deployment: { group: "apps", resource: "deployments" },
  Service: { group: "", resource: "services" },
  Ingress: { group: "networking.k8s.io", resource: "ingresses" },
  ConfigMap: { group: "", resource: "configmaps" },
  Secret: { group: "", resource: "secrets" },
  StatefulSet: { group: "apps", resource: "statefulsets" },
  DaemonSet: { group: "apps", resource: "daemonsets" },
  Job: { group: "batch", resource: "jobs" },
  CronJob: { group: "batch", resource: "cronjobs" },
  PersistentVolumeClaim: { group: "", resource: "persistentvolumeclaims" },
};

export function RBACCheckPanel({ cluster, namespace, kinds }: Props) {
  const t = useTranslations("templates.rbac");
  const [results, setResults] = useState<CheckResult[]>([]);
  const [loading, setLoading] = useState(false);

  const hasInputs = Boolean(cluster) && Boolean(namespace) && kinds.length > 0;

  // NOTE: `kinds.join(",")` stabilizes the dep — using `kinds` directly would
  // re-run the effect on every render because a new array reference is common
  // from parents. Do not "fix" this by adding `kinds` to the dep list.
  useEffect(() => {
    if (!hasInputs) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all(
      kinds.map(async (k): Promise<CheckResult> => {
        const map = KIND_TO_RESOURCE[k];
        if (!map) {
          return { allowed: true, resource: k, reason: "unknown kind — skipped" };
        }
        try {
          const res = await fetch("/api/v1/selfsubjectaccessreview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cluster, namespace, verb: "create", ...map }),
          });
          if (!res.ok) {
            return {
              allowed: false,
              resource: k,
              reason: `HTTP ${res.status}`,
              httpStatus: res.status,
            };
          }
          const body = (await res.json()) as { allowed: boolean; reason: string };
          return { allowed: body.allowed, resource: k, reason: body.reason ?? "" };
        } catch (err) {
          return {
            allowed: false,
            resource: k,
            reason: err instanceof Error ? err.message : String(err),
            httpStatus: 0,
          };
        }
      }),
    )
      .then((r) => {
        if (active) setResults(r);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, namespace, kinds.join(","), hasInputs]);

  // When inputs are missing we render the placeholder regardless of any
  // stale `results` from a previous valid render — avoids calling setState
  // from inside the effect just to reset on input clear.
  const effectiveResults = hasInputs ? results : [];
  const allAllowed = effectiveResults.length > 0 && effectiveResults.every((r) => r.allowed);
  const anyDenied = effectiveResults.some((r) => !r.allowed);
  const showPlaceholder = !loading && effectiveResults.length === 0;

  return (
    <Card>
      <CardHeader className="text-sm font-medium">{t("title")}</CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        {loading && <span className="text-muted-foreground">{t("checking")}</span>}
        {showPlaceholder && (
          <span className="text-muted-foreground">{t("hint")}</span>
        )}
        {!loading && allAllowed && (
          <span className="text-green-700">{t("allAllowed")}</span>
        )}
        {!loading && anyDenied && (
          <ul className="flex flex-col gap-0.5">
            {effectiveResults
              .filter((r) => !r.allowed)
              .map((r) => {
                // Distinguish a failed check (HTTP / network) from a genuine
                // RBAC deny. httpStatus === 0 means a network error; any other
                // number means a non-2xx response from the check endpoint.
                const isHttpError = r.httpStatus !== undefined;
                const message = isHttpError
                  ? t("httpError", { status: r.httpStatus ?? 0 })
                  : r.reason || t("denied");
                return (
                  <li key={r.resource} className="text-red-700">
                    ❌ {r.resource}: {message}
                  </li>
                );
              })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
