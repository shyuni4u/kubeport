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
  /**
   * The form's values do not parse, so no preview was asked for (#319). Says
   * so instead of the "fill in the form" hint, which reads as if nothing were
   * entered yet.
   */
  paused?: boolean;
};

type Resource = { apiVersion: string; kind: string; name: string | null };

export function ResourcesPreview({ renderedYaml, pending, paused = false }: Props) {
  const t = useTranslations("deploy.preview");
  const tKinds = useTranslations("kinds");
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const resources = useMemo<Resource[]>(() => {
    if (!renderedYaml) return [];
    try {
      const docs = YAML.parseAllDocuments(renderedYaml);
      return docs
        .map(
          (d) =>
            d.toJS() as {
              apiVersion?: string;
              kind?: string;
              metadata?: { name?: string };
            } | null,
        )
        .filter(
          (x): x is { apiVersion?: string; kind: string; metadata?: { name?: string } } =>
            !!x && typeof x.kind === "string",
        )
        .map((x) => ({
          apiVersion: typeof x.apiVersion === "string" ? x.apiVersion : "",
          kind: x.kind,
          name: x.metadata?.name ?? null,
        }));
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
        <p className="text-xs text-muted-foreground">{t(paused ? "invalid" : "empty")}</p>
      )}
      {resources.length > 0 && (
        <ul className="flex flex-col gap-1">
          {resources.map((r, idx) => (
            <li
              key={`${r.apiVersion}-${r.kind}-${r.name}-${idx}`}
              // The plain labels have spaces ("저장 공간이 붙은 앱"), so with no
              // gap they wrapped first and ran into the name. The label stays
              // on one line; only a long name wraps, against the right edge.
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span
                className={
                  kube
                    ? "shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground"
                    : "shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                }
              >
                {/* Raw terms show what the manifest says, apiVersion included:
                    a kind name alone cannot tell batch/v1 from a CRD. */}
                {kube && r.apiVersion
                  ? `${r.apiVersion} ${r.kind}`
                  : kindLabel(r.kind, kube, (k) => tKinds(k), r.apiVersion)}
              </span>
              <span
                className={
                  kube
                    ? "min-w-0 break-words text-right font-mono text-xs"
                    : "min-w-0 break-words text-right"
                }
              >
                {r.name ?? t("unnamed")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
