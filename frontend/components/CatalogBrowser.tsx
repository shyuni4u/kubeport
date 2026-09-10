"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CatalogCard, type CatalogCardTemplate } from "./CatalogCard";

type Props = { templates: CatalogCardTemplate[] };

/**
 * The value the "전체" chip carries. Tags are k8s-ish label values from template
 * metadata, which cannot contain `_` at either end, so this cannot collide with
 * a real tag.
 */
const ALL_TAGS = "__all__";

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
        // `name` first: it is the identifier the user meets everywhere else —
        // the URL, the deploy header, their release rows — so it is the first
        // thing they type. Tags are searched too, since the tag chips only
        // offer one at a time (#32).
        const hay = [t.name, t.display_name, t.description ?? "", ...t.tags]
          .join(" ")
          .toLowerCase();
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
        // `ALL_TAGS` rather than `""`: base-ui treats an empty string as "no
        // value", so an item carrying it can never read as pressed — and a
        // filter whose "off" state looks the same as its "on" state is the bug
        // this is fixing (#110). The sentinel is mapped back to "" on the way
        // into `tag`, so the filter itself still works on a plain tag string.
        <ToggleGroup
          value={[tag || ALL_TAGS]}
          onValueChange={(v) => setTag(v[0] === ALL_TAGS ? "" : (v[0] ?? ""))}
          className="flex-wrap justify-start"
          aria-label={t("tagFilterLabel")}
        >
          <ToggleGroupItem value={ALL_TAGS} variant="outline">
            {t("allTags")}
          </ToggleGroupItem>
          {allTags.map((t) => (
            <ToggleGroupItem key={t} value={t} variant="outline">
              {t}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {t("emptyNoMatch")}
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
          {filtered.map((t) => (
            <CatalogCard key={t.name} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}
