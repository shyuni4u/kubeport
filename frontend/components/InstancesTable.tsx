"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip, type StatusVariant } from "./StatusChip";

// Pod phases / waiting reasons → chip colour. A broken instance
// (CrashLoopBackOff, ImagePullBackOff, Error…) must not look like "muted".
export function instanceVariant(ready: boolean, phase: string): StatusVariant {
  if (ready) return "success";
  if (/backoff|err|fail|oom|evicted/i.test(phase)) return "danger";
  if (/pending|creating|init|terminating|waiting/i.test(phase)) return "warning";
  return "muted";
}
import { termLabel, type TermKey } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export type Instance = {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
};

export function InstancesTable({
  releaseId,
  instances,
}: {
  releaseId: string;
  instances: Instance[];
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
    "CreateContainerConfigError",
    "ContainerCreating",
    "Terminating",
    "Completed",
  ]);
  const phaseLabel = (phase: string): string =>
    KNOWN_PHASES.has(phase) ? tPhase(phase) : phase;
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
        {instances.map((i) => (
          <TableRow key={i.name}>
            <TableCell className="font-mono text-xs">{i.name}</TableCell>
            <TableCell>
              <StatusChip
                variant={instanceVariant(i.ready, i.phase)}
              >
                <span title={i.phase}>{phaseLabel(i.phase)}</span>
              </StatusChip>
            </TableCell>
            <TableCell>{i.restarts}</TableCell>
            <TableCell>
              <Link
                href={`/releases/${releaseId}/logs?instance=${i.name}`}
                className="text-primary hover:underline text-xs"
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
