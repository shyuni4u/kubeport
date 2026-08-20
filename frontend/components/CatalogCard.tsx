"use client";

import { createElement } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { iconFor } from "@/lib/template-icons";

export type CatalogCardTemplate = {
  name: string;
  display_name: string;
  description: string | null;
  tags: string[];
  current_version: number;
  owning_team_name?: string | null;
};

type Props = { template: CatalogCardTemplate };

export function CatalogCard({ template }: Props) {
  const t = useTranslations("catalog.card");
  const icon = iconFor(template.tags);
  const teamLabel = template.owning_team_name ?? "—";
  return (
    <div className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          {createElement(icon, { className: "h-5 w-5" })}
        </span>
        <h3 className="text-sm font-semibold">{template.display_name}</h3>
      </div>
      <p className="min-h-9 text-xs text-muted-foreground line-clamp-2">
        {template.description ?? ""}
      </p>
      <div className="flex flex-wrap gap-1">
        {template.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">
            {t}
          </Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          v{template.current_version} · {teamLabel}
        </span>
        <Link
          href={`/catalog/${template.name}/deploy`}
          className="font-medium text-primary hover:underline"
        >
          {t("deploy")}
        </Link>
      </div>
    </div>
  );
}
