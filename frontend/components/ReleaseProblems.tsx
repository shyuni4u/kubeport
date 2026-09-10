"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import type { Instance } from "./InstancesTable";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Cause =
  | "image"
  | "crash"
  | "exited"
  | "memory"
  | "config"
  | "capacity"
  | "evicted"
  | "other";

// k8s reasons grouped by what the reader would do about them. The table says
// "이미지를 가져올 수 없음" on every row; this says it once, as a sentence, with
// the next step — a failed release used to show a chip and nothing else (#33).
const CAUSE_OF: Record<string, Cause> = {
  ImagePullBackOff: "image",
  ErrImagePull: "image",
  InvalidImageName: "image",
  CrashLoopBackOff: "crash",
  // A container that ended with an error is not necessarily restarting: a Job
  // with restartPolicy Never stops there, so "keeps restarting" would be false.
  Error: "exited",
  OOMKilled: "memory",
  CreateContainerConfigError: "config",
  CreateContainerError: "config",
  Unschedulable: "capacity",
  Evicted: "evicted",
};

// Causes a new value can fix: another image, a higher memory limit, a setting
// the app chokes on. Waiting for capacity and eviction clear on their own or
// need an admin, and a missing referenced value is not something the form
// holds, so offering a redeploy for those sends the reader the wrong way.
const FIXED_BY_SETTINGS = new Set<Cause>(["image", "crash", "exited", "memory"]);

export type ProblemGroup = {
  cause: Cause;
  /** Distinct k8s reasons in this group, in order of first appearance. */
  reasons: string[];
  count: number;
  /** The first instance's k8s message, prefixed with its name. */
  detail?: string;
};

/** Instances with a reason, grouped by cause in order of first appearance. */
export function groupProblems(instances: Instance[]): ProblemGroup[] {
  const groups = new Map<Cause, ProblemGroup>();
  for (const i of instances) {
    if (!i.reason) continue;
    const cause = CAUSE_OF[i.reason] ?? "other";
    let g = groups.get(cause);
    if (!g) {
      g = { cause, reasons: [], count: 0 };
      groups.set(cause, g);
    }
    g.count++;
    if (!g.reasons.includes(i.reason)) g.reasons.push(i.reason);
    if (!g.detail && i.message) g.detail = `${i.name}: ${i.message}`;
  }
  return [...groups.values()];
}

export function ReleaseProblems({
  releaseId,
  template,
  version,
  instances,
}: {
  releaseId: string;
  template: string;
  /** The template version the release is pinned to. */
  version: number;
  instances: Instance[];
}) {
  const t = useTranslations("releases.problems");
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const groups = groupProblems(instances);
  if (groups.length === 0) return null;
  const offerUpdate = groups.some((g) => FIXED_BY_SETTINGS.has(g.cause));
  return (
    <section
      aria-labelledby="release-problems-heading"
      className="flex gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1 space-y-3">
        <h2 id="release-problems-heading" className="font-medium">
          {t("heading")}
        </h2>
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.cause} className="space-y-1 text-sm">
              <p>{t(`cause.${g.cause}.what`, { count: g.count })}</p>
              <p className="text-muted-foreground">{t(`cause.${g.cause}.fix`)}</p>
              {/* k8s's own words, verbatim, for whoever asked to see them. */}
              {kube && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {g.reasons.join(", ")}
                  {g.detail ? ` — ${g.detail}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
        {offerUpdate && (
          // The version-pinned route, not /catalog/<t>/deploy: only it loads
          // the release's current values into the form, so the reader fixes
          // the one wrong value instead of resetting every field to the
          // template's defaults — and stays on the version the release runs.
          <Link
            href={`/catalog/${encodeURIComponent(template)}/versions/${version}/deploy?updateReleaseId=${encodeURIComponent(releaseId)}`}
            className="inline-block text-sm text-link hover:underline"
          >
            {t("changeSettings")}
          </Link>
        )}
      </div>
    </section>
  );
}
