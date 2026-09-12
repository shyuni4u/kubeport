"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { groupOf, kindLabel } from "@/lib/kube-kinds";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

/**
 * What the preflight can conclude about this deploy.
 *
 * `denied` is deliberately narrow: it means k8s answered a SelfSubjectAccess-
 * Review with `allowed: false`. A check that could not be *made* — HTTP error,
 * network failure, or a kind with no resource mapping — stays `unknown` so a
 * broken preflight never strands the user behind a disabled button.
 */
export type RbacStatus = "unknown" | "allowed" | "denied";

/**
 * A rendered object to check. With its apiVersion, a kind is checked only when
 * that apiVersion is in the group the name maps to: Knative's
 * `serving.knative.dev/v1` Service is not a core Service, and an SSAR about
 * core `services` would answer a question nobody asked (#248). A bare kind
 * name is taken at its word.
 */
export type KindRef = string | { apiVersion: string; kind: string };

const refKind = (r: KindRef) => (typeof r === "string" ? r : r.kind);
const refApiVersion = (r: KindRef) => (typeof r === "string" ? undefined : r.apiVersion);
const refKey = (r: KindRef) => (typeof r === "string" ? r : `${groupOf(r.apiVersion)}/${r.kind}`);

type Props = {
  cluster: string;
  namespace: string;
  kinds: KindRef[];
  /**
   * Reports the panel's verdict upward so the deploy form can block a submit
   * that k8s has already told us will fail (#30). Must be referentially
   * stable — wrap it in useCallback.
   */
  onResult?: (status: RbacStatus) => void;
  /**
   * Why there is nothing to check yet, when it is not the missing cluster or
   * namespace the default hint names — e.g. the deploy form's values do not
   * parse, so there is no preview to take kinds from (#319).
   */
  idleReason?: string;
};

type CheckResult = {
  allowed: boolean;
  resource: string;
  // The object's apiVersion when the caller gave one; names the row in the
  // viewer's words only when it is the group the kind name maps to.
  apiVersion?: string;
  // Unique per checked object: a core Service and a CRD called Service are
  // two rows.
  key: string;
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

/**
 * The verdict for a finished set of checks. The render (what the panel shows)
 * and the fetch callback (what the deploy form hears) both use it, so they
 * cannot disagree about what counts as a denial.
 *
 * Only a real RBAC "no" is a denial — see RbacStatus. `httpStatus` set means
 * the check failed rather than the permission being absent.
 */
function statusFrom(results: CheckResult[]): RbacStatus {
  const checked = results.filter((r) => !r.skipped);
  if (checked.some((r) => !r.allowed && r.httpStatus === undefined)) return "denied";
  // "All allowed" only speaks for kinds we could actually check — skipped
  // kinds are reported separately so the panel never shows green for a
  // deploy that may still be denied.
  if (checked.length > 0 && checked.every((r) => r.allowed)) return "allowed";
  return "unknown";
}

export function RBACCheckPanel({ cluster, namespace, kinds, onResult, idleReason }: Props) {
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
      kinds.map(async (ref): Promise<CheckResult> => {
        const k = refKind(ref);
        const apiVersion = refApiVersion(ref);
        const base = { resource: k, apiVersion, key: refKey(ref) };
        const map = KIND_TO_RESOURCE[k];
        // No mapping, or a CRD that only shares a core kind's name: nothing
        // kubeport can ask about, so not checked rather than asked wrongly.
        if (!map || (apiVersion !== undefined && groupOf(apiVersion) !== map.group)) {
          return { ...base, allowed: false, skipped: true, reason: "" };
        }
        try {
          const res = await fetch("/api/v1/selfsubjectaccessreview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cluster, namespace, verb: "create", ...map }),
          });
          if (!res.ok) {
            return {
              ...base,
              allowed: false,
              reason: `HTTP ${res.status}`,
              httpStatus: res.status,
            };
          }
          const body = (await res.json()) as { allowed: boolean; reason: string };
          return { ...base, allowed: body.allowed, reason: body.reason ?? "" };
        } catch (err) {
          return {
            ...base,
            allowed: false,
            reason: err instanceof Error ? err.message : String(err),
            httpStatus: 0,
          };
        }
      }),
    ).then((r) => {
      if (!active) return;
      // Results, the end of loading and the verdict go up together, so React
      // commits the denied rows and the parent's disabled button at once
      // (#99). Reporting the verdict from the effect below instead left one
      // commit where the panel said "denied" and the button still worked.
      // `loading` is cleared in the same callback rather than a `.finally`, so
      // all three are scheduled together instead of relying on a later
      // microtask landing in the same render.
      //
      // onResult is the one captured when this check started. The parent
      // stamps the verdict with the cluster and namespace it closes over, and
      // those are the inputs this check was for: had they changed, the cleanup
      // would have set `active` false and nothing would be reported.
      setResults(r);
      setLoading(false);
      onResult?.(statusFrom(r));
    });
    // Every check above settles to a result — none rejects — so there is no
    // failure branch to leave `loading` stuck.
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, namespace, kinds.map(refKey).join(","), hasInputs]);

  // When inputs are missing we render the placeholder regardless of any
  // stale `results` from a previous valid render — avoids calling setState
  // from inside the effect just to reset on input clear.
  const effectiveResults = hasInputs ? results : [];
  const checked = effectiveResults.filter((r) => !r.skipped);
  const skipped = effectiveResults.filter((r) => r.skipped);
  const allAllowed = checked.length > 0 && checked.every((r) => r.allowed);
  const denied = checked.filter((r) => !r.allowed);
  // `loading` can outlive its inputs: clear them while a check is out and the
  // cleanup drops that check's result, so nothing ever sets it back to false.
  // What is on screen follows the inputs instead of the flag.
  const checking = loading && hasInputs;
  const showPlaceholder = !checking && effectiveResults.length === 0;

  const status: RbacStatus =
    loading || !hasInputs ? "unknown" : statusFrom(effectiveResults);

  // Still reported from an effect as well, for what the fetch callback never
  // sees: cleared inputs and a re-check starting both go back to "unknown".
  // For a finished check it repeats what the callback already sent. The
  // verdict is the same, so the parent's gate does not change — though a
  // parent that stores an object (DeployClient) re-renders once more.
  useEffect(() => {
    onResult?.(status);
  }, [status, onResult]);

  // Kinds and the verb in the viewer's words unless they asked for the raw
  // terms (#39). The deploy form's user meets "ConfigMap" or "create" nowhere
  // else on the page.
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const tKinds = useTranslations("kinds");
  const kind = (r: CheckResult) => kindLabel(r.resource, kube, (key) => tKinds(key), r.apiVersion);

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 text-sm font-medium">
        <span>{t("title")}</span>
        {hasInputs && (
          <span
            className={
              kube
                ? "font-mono text-xs font-normal text-muted-foreground"
                : "text-xs font-normal text-muted-foreground"
            }
          >
            {kube ? `create · ${namespace}` : t("scope", { namespace })}
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        {checking && <span className="text-muted-foreground">{t("checking")}</span>}
        {showPlaceholder && (
          <span className="text-muted-foreground">{idleReason ?? t("hint")}</span>
        )}
        {/*
          Icons are lucide, not emoji (#114). The panel used ❌/⚠ literals
          while StatusChip and ReleaseStaleBanner next to it used lucide, so
          one card rendered in the platform's emoji font at a size and weight
          nothing else on the page shared.

          Every icon is aria-hidden: the sentence beside it already says the
          same thing, and an emoji's own name ("cross mark") was being read
          out ahead of it.
        */}
        {!checking && allAllowed && (
          <span className="flex items-center gap-1.5 text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("allAllowed")}
          </span>
        )}
        {!checking && denied.length > 0 && (
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
                // Raw terms name what the review asked k8s about, the way an
                // admin fixes a RoleBinding: verb and group/resource, with
                // k8s's own reason under it instead of only on hover (#39).
                const map = KIND_TO_RESOURCE[r.resource];
                const label = kube
                  ? `create ${map?.group ? `${map.group}/` : ""}${map?.resource ?? r.resource}`
                  : kind(r);
                return (
                  <li
                    key={r.key}
                    className="flex items-start gap-1.5 text-red-700 dark:text-red-400"
                    title={r.reason || undefined}
                  >
                    <XCircle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span>{t("deniedRow", { resource: label, message })}</span>
                      {kube && r.reason && (
                        <span className="block break-all font-mono text-muted-foreground">
                          {r.reason}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-red-700 dark:text-red-400">{t("deniedNext")}</p>
          </>
        )}
        {!checking && skipped.length > 0 && (
          <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t("skipped", {
                kinds: skipped.map((r) => kind(r)).join(", "),
              })}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
