"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CatalogCard, type CatalogCardTemplate } from "./CatalogCard";

type Props = { templates: CatalogCardTemplate[] };

export function CatalogBrowser({ templates }: Props) {
  const t = useTranslations("catalog");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string>("");

  const allTags = useMemo(
    () => Array.from(new Set(templates.flatMap((t) => t.tags))).sort(),
    [templates],
  );

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (tag && !t.tags.includes(tag)) return false;
      if (ql) {
        const hay = (t.display_name + " " + (t.description ?? "")).toLowerCase();
        if (!hay.includes(ql)) return false;
      }
      return true;
    });
  }, [templates, q, tag]);

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
        <p className="text-sm">{t("emptyNoTemplates")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <Input
          className="max-w-xs"
          placeholder={t("searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {allTags.length > 0 && (
        <ToggleGroup
          value={tag ? [tag] : []}
          onValueChange={(v) => setTag(v[0] ?? "")}
          className="flex-wrap justify-start"
        >
          {allTags.map((t) => (
            <ToggleGroupItem key={t} value={t}>{t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {t("emptyNoMatch")}
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(190px,1fr))]">
          {filtered.map((t) => (
            <CatalogCard key={t.name} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}
