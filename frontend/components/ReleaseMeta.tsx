"use client";

import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/RelativeTime";
import { termLabel } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

/**
 * The release header's meta line, with its values named. "oci-a1 / demo" did
 * not say that "demo" is the 구역 the release was deployed into (#259). A client
 * component so the namespace label follows the terms switch in the same header
 * — 구역 by default, Namespace with Kubernetes terms on.
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
  return (
    <div className="text-sm text-muted-foreground">
      {template} v{version}
      {" · "}
      {tm("cluster")} <span className="text-foreground">{cluster}</span>
      {" · "}
      {termLabel("namespace", kube, (k) => tTerms(k))}{" "}
      <span className="text-foreground">{namespace}</span>
      {createdAt ? (
        <>
          {" · "}
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
