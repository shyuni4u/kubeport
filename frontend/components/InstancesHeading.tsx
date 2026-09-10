"use client";

import { useTranslations } from "next-intl";
import { termLabel } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

/**
 * The overview's instances heading, in the same words as the table under it.
 * It was a fixed "인스턴스 (n)" above a table whose headers already said
 * "Pod Name" with raw terms on (#250). Plain words keep the message, which
 * owns the word order; raw terms use the k8s word.
 */
export function InstancesHeading({ count }: { count: number }) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const tOverview = useTranslations("releases.overview");
  const tTerms = useTranslations("releases.terms");
  return (
    <h2 className="mb-2 text-sm font-medium">
      {kube
        ? `${termLabel("instances", true, (k) => tTerms(k))} (${count})`
        : tOverview("instancesHeading", { count })}
    </h2>
  );
}
