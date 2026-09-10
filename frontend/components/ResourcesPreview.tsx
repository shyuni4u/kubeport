"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import YAML from "yaml";
import { KubeTermsToggle } from "@/components/KubeTermsToggle";
import { kindLabel } from "@/lib/kube-kinds";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Props = {
  renderedYaml: string | null;
  pending: boolean;
};

type Resource = { kind: string; name: string };

export function ResourcesPreview({ renderedYaml, pending }: Props) {
  const t = useTranslations("deploy.preview");
  const tKinds = useTranslations("kinds");
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const resources = useMemo<Resource[]>(() => {
    if (!renderedYaml) return [];
    try {
      const docs = YAML.parseAllDocuments(renderedYaml);
      return docs
        .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string } } | null)
        .filter(
          (x): x is { kind: string; metadata?: { name?: string } } =>
            !!x && typeof x.kind === "string",
        )
        .map((x) => ({ kind: x.kind, name: x.metadata?.name ?? "(unnamed)" }));
    } catch {
      return [];
    }
  }, [renderedYaml]);

  return (
    <aside className="flex flex-col gap-3 rounded-md bg-muted p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("heading")}</h2>
        {/*
          The same switch as the release detail header. This list and the
          permission panel under it are where the deploy form printed raw
          kinds to a user the rest of the page never shows them to (#39).
        */}
        <KubeTermsToggle />
      </div>
      {pending && <p className="text-xs text-muted-foreground">{t("rendering")}</p>}
      {!pending && resources.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      )}
      {resources.length > 0 && (
        <ul className="flex flex-col gap-1">
          {resources.map((r, idx) => (
            <li
              key={`${r.kind}-${r.name}-${idx}`}
              className="flex items-center justify-between text-sm"
            >
              <span
                className={
                  kube
                    ? "font-mono text-xs text-muted-foreground"
                    : "text-xs text-muted-foreground"
                }
              >
                {kindLabel(r.kind, kube, (k) => tKinds(k))}
              </span>
              <span>{r.name}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
