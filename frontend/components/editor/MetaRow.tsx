"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export type TemplateMeta = {
  name: string;
  display_name?: string;
  team?: string | null;
  tags: string[];
};

type Props = {
  meta: TemplateMeta;
  onChange: (m: TemplateMeta) => void;
  nameLocked?: boolean;
  /**
   * When true, all fields (name, team, tags) are rendered read-only. Used on
   * the version-edit page where the backend has no endpoint for updating
   * parent-template metadata (display_name/tags), so exposing these as
   * editable would silently drop the user's changes on save.
   */
  readOnly?: boolean;
  /**
   * Hide the team text input. Use when the caller renders its own team
   * picker (e.g. /templates/new uses a Select bound to owning_team_id) — a
   * second free-text "팀" input here would be confusing and meta.team is
   * not sent to the backend in those flows.
   */
  hideTeam?: boolean;
};

export function MetaRow({ meta, onChange, nameLocked, readOnly, hideTeam }: Props) {
  const t = useTranslations("templates.editor.meta");
  const [tagInput, setTagInput] = useState("");
  const lockAll = readOnly === true;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("name")}</span>
        <Input
          className="w-48 text-sm"
          placeholder={t("namePlaceholder")}
          value={meta.name}
          disabled={nameLocked || lockAll}
          onChange={(e) => onChange({ ...meta, name: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("displayName")}</span>
        <Input
          className="w-48 text-sm"
          placeholder={t("displayName")}
          value={meta.display_name ?? ""}
          disabled={lockAll}
          onChange={(e) => onChange({ ...meta, display_name: e.target.value })}
        />
      </label>
      {!hideTeam && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("team")}</span>
          <Input
            className="w-32 text-sm"
            value={meta.team ?? ""}
            disabled={lockAll}
            onChange={(e) => onChange({ ...meta, team: e.target.value })}
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {meta.tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-[10px]">
            {tag}
            {!lockAll && (
              <button
                type="button"
                aria-label={t("removeTag", { tag })}
                className="ml-1 opacity-60 hover:opacity-100"
                onClick={() =>
                  onChange({
                    ...meta,
                    tags: meta.tags.filter((x) => x !== tag),
                  })
                }
              >
                ×
              </button>
            )}
          </Badge>
        ))}
        {!lockAll && (
          <Input
            placeholder={t("addTag")}
            className="h-7 w-28 text-xs"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagInput.trim()) {
                e.preventDefault();
                const next = tagInput.trim();
                if (!meta.tags.includes(next)) {
                  onChange({ ...meta, tags: [...meta.tags, next] });
                }
                setTagInput("");
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
