"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * What the preflight can conclude about this deploy.
 *
 * `denied` is deliberately narrow: it means k8s answered a SelfSubjectAccess-
 * Review with `allowed: false`. A check that could not be *made* — HTTP error,
 * network failure, or a kind with no resource mapping — stays `unknown` so a
 * broken preflight never strands the user behind a disabled button.
 */
export type RbacStatus = "unknown" | "allowed" | "denied";

type Props = {
  cluster: string;
  namespace: string;
  kinds: string[];
  /**
   * Reports the panel's verdict upward so the deploy form can block a submit
   * that k8s has already told us will fail (#30). Must be referentially
   * stable — wrap it in useCallback.
   */
  onResult?: (status: RbacStatus) => void;
};

type CheckResult = {
  allowed: boolean;
  resource: string;
  reason: string;
  // When the check itself failed (network / non-2xx), we surface a distinct
  // "check failed" message instead of an RBAC-deny message.
  httpStatus?: number;
  // Kind has no resource mapping, so no SSAR was sent. Never counted as
  // "allowed" — the deploy may still be denied for it.
  skipped?: boolean;
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

export function RBACCheckPanel({ cluster, namespace, kinds, onResult }: Props) {
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
          return { allowed: false, skipped: true, resource: k, reason: "" };
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
  const checked = effectiveResults.filter((r) => !r.skipped);
  const skipped = effectiveResults.filter((r) => r.skipped);
  // "All allowed" only speaks for kinds we could actually check — skipped
  // kinds are reported separately so the panel never shows green for a
  // deploy that may still be denied.
  const allAllowed = checked.length > 0 && checked.every((r) => r.allowed);
  const denied = checked.filter((r) => !r.allowed);
  const showPlaceholder = !loading && effectiveResults.length === 0;

  // Only a real RBAC "no" is a denial — see RbacStatus. `httpStatus` set means
  // the check failed rather than the permission being absent.
  const status: RbacStatus =
    loading || !hasInputs
      ? "unknown"
      : denied.some((r) => r.httpStatus === undefined)
        ? "denied"
        : allAllowed
          ? "allowed"
          : "unknown";

  // Reported from its own effect (not inside the fetch) so the parent also
  // hears about resets — cleared cluster, emptied kinds, a re-check starting.
  useEffect(() => {
    onResult?.(status);
  }, [status, onResult]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 text-sm font-medium">
        <span>{t("title")}</span>
        {hasInputs && (
          <span className="font-mono text-xs font-normal text-muted-foreground">
            create · {namespace}
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        {loading && <span className="text-muted-foreground">{t("checking")}</span>}
        {showPlaceholder && (
          <span className="text-muted-foreground">{t("hint")}</span>
        )}
        {!loading && allAllowed && (
          <span className="text-green-700">{t("allAllowed")}</span>
        )}
        {!loading && denied.length > 0 && (
          <>
            <ul className="flex flex-col gap-0.5">
              {denied.map((r) => {
                // Distinguish a failed check (HTTP / network) from a genuine
                // RBAC deny. httpStatus === 0 means a network error; any other
                // number means a non-2xx response from the check endpoint.
                // The raw k8s reason is admin-only hover text — the visible
                // sentence is always ours.
                const isHttpError = r.httpStatus !== undefined;
                const message = isHttpError
                  ? t("httpError", { status: r.httpStatus ?? 0 })
                  : t("denied");
                return (
                  <li key={r.resource} className="text-red-700" title={r.reason || undefined}>
                    ❌ {t("deniedRow", { resource: r.resource, message })}
                  </li>
                );
              })}
            </ul>
            <p className="text-red-700">{t("deniedNext")}</p>
          </>
        )}
        {!loading && skipped.length > 0 && (
          <p className="text-amber-700">
            ⚠ {t("skipped", { kinds: skipped.map((r) => r.resource).join(", ") })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
