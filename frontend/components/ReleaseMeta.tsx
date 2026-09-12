"use client";

import { useTranslations } from "next-intl";
import { HelpHint } from "@/components/HelpHint";
import { RelativeTime } from "@/components/RelativeTime";
import { termLabel } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

// Keeps a label on the same line as its value, and a separator at the end of
// the segment before it: on a 390px screen a plain space let "Namespace" end
// one line and "demo" start the next, which undid the label (#259 review).
const NBSP = " ";

/**
 * The release header's meta line, with its values named. "oci-a1 / demo" did
 * not say that "demo" is the 구역 the release was deployed into (#259). A client
 * component so the namespace label follows the terms switch in the same header
 * — 구역 by default, Namespace with Kubernetes terms on.
 *
 * One muted tone like every other meta line in the app; the labels do the
 * naming. "클러스터" gets the deploy form's explanation behind a (?), since
 * this line may be the first place a newcomer meets the word.
 */
export function ReleaseMeta({
  template,
  version,
  cluster,
  namespace,
  createdAt,
}: {
  template: string;
  version: number;
  cluster: string;
  namespace: string;
  createdAt?: string;
}) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const tm = useTranslations("releases.meta");
  const tTerms = useTranslations("releases.terms");
  const tDeploy = useTranslations("deploy");
  return (
    <div className="text-sm text-muted-foreground">
      {template} v{version}
      {`${NBSP}· `}
      {tm("cluster")}
      <HelpHint text={tDeploy("clusterHelp")} className="mx-0.5" />
      {NBSP}
      {cluster}
      {`${NBSP}· `}
      {termLabel("namespace", kube, (k) => tTerms(k))}
      {NBSP}
      {namespace}
      {createdAt ? (
        <>
          {`${NBSP}· `}
          {/*
            t.rich, not string concatenation: Korean puts "배포" after the
            time and English puts "deployed" before it, so the word order
            has to live in the message, not in the JSX (#40).
          */}
          {tm.rich("deployedAt", {
            time: () => <RelativeTime iso={createdAt} />,
          })}
        </>
      ) : null}
    </div>
  );
}
