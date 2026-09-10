"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip, type StatusVariant } from "./StatusChip";

// Pod phases / waiting reasons → chip colour. A broken instance
// (CrashLoopBackOff, ImagePullBackOff, Error…) must not look like "muted".
export function instanceVariant(ready: boolean, phase: string): StatusVariant {
  if (ready) return "success";
  if (/backoff|err|fail|oom|evicted|invalid/i.test(phase)) return "danger";
  if (/pending|creating|init|terminating|waiting|unschedulable/i.test(phase)) return "warning";
  return "muted";
}
import { termLabel, type TermKey } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export type Instance = {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  /**
   * Why the pod is not running normally, in k8s's word (ImagePullBackOff,
   * OOMKilled, Unschedulable…), absent when there is nothing to explain.
   * Phase cannot say it: a pod that will never pull its image is "Pending"
   * for good (#33).
   */
  reason?: string;
  /** k8s's own detail for `reason`, verbatim. */
  message?: string;
};

export function InstancesTable({
  releaseId,
  instances,
  staleNotice = false,
}: {
  releaseId: string;
  instances: Instance[];
  /**
   * True when a ReleaseStaleBanner sits above this table. It decides which
   * empty-state sentence to use: pointing at "the notice above" is only
   * honest when there is one, and an empty table is perfectly normal without
   * it — a CronJob between runs, a Deployment scaled to zero.
   */
  staleNotice?: boolean;
}) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const tInstances = useTranslations("releases.instances");
  const tPhase = useTranslations("releases.phase");
  const tTerms = useTranslations("releases.terms");
  const L = (key: TermKey) => termLabel(key, kube, tTerms);
  // Map a k8s pod phase / waiting reason to plain language, falling back to
  // the raw phase string when we have no key for it. We whitelist known keys
  // rather than relying on t.has() so an unmapped phase renders verbatim
  // instead of showing a missing-message error.
  const KNOWN_PHASES = new Set([
    "Running",
    "Pending",
    "Succeeded",
    "Failed",
    "Unknown",
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "ContainerCreating",
    "OOMKilled",
    "Error",
    "Evicted",
    "Unschedulable",
    "Terminating",
    "Completed",
  ]);
  // Raw terms show k8s's own word, as `kubectl get pods` would: a "Status"
  // header over "반복 재시작 중" was half of each (#39 made raw the admin
  // default here).
  const phaseLabel = (phase: string): string =>
    kube || !KNOWN_PHASES.has(phase) ? phase : tPhase(phase);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{L("instanceId")}</TableHead>
          <TableHead>{L("status")}</TableHead>
          <TableHead>{L("restarts")}</TableHead>
          <TableHead className="w-20"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {/*
          An empty <tbody> left the header row floating over blank space with
          nothing saying whether the table was loading, broken, or simply
          empty (#114). This is server-rendered with the data, so there is no
          loading state to distinguish — say it is empty.
        */}
        {instances.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={4}
              className="py-8 text-center text-sm text-muted-foreground"
            >
              {tInstances(staleNotice ? "emptyWithNotice" : "empty")}
            </TableCell>
          </TableRow>
        )}
        {instances.map((i) => (
          <TableRow key={i.name}>
            {/* Truncated below sm: the status chip now carries the reason, a
                longer label, and a full pod name pushed it off a 390px screen. */}
            <TableCell
              className="max-w-[8rem] truncate font-mono text-xs sm:max-w-none"
              title={i.name}
            >
              {i.name}
            </TableCell>
            <TableCell>
              {/* The reason, when there is one, is the word worth showing:
                  "Pending" says nothing about a pod that will never pull its
                  image (#33). The colour reads both, so a reason the patterns
                  do not know still takes a Failed or Pending phase's colour
                  instead of going grey. */}
              <StatusChip
                variant={instanceVariant(
                  i.ready,
                  [i.reason, i.phase].filter(Boolean).join(" "),
                )}
              >
                <span title={i.reason || i.phase}>
                  {phaseLabel(i.reason || i.phase)}
                </span>
              </StatusChip>
            </TableCell>
            <TableCell>{i.restarts}</TableCell>
            <TableCell>
              <Link
                href={`/releases/${releaseId}/logs?instance=${i.name}`}
                className="text-link hover:underline text-xs"
              >
                {tInstances("logsLink")}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
