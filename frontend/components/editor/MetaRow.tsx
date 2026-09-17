"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { fieldLabelClass } from "@/components/ui/field-styles";
import { Badge } from "@/components/ui/badge";
import { TEMPLATE_NAME_MAX_LENGTH, templateNameProblem } from "@/lib/template-name";

export type TemplateMeta = {
  name: string;
  display_name?: string;
  team?: string | null;
  tags: string[];
};

type Props = {
  children?: React.ReactNode;
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

export function MetaRow({ meta, onChange, nameLocked, readOnly, hideTeam, children }: Props) {
  const t = useTranslations("templates.editor.meta");
  const [tagInput, setTagInput] = useState("");
  const lockAll = readOnly === true;
  // A name the API would refuse says so while it is typed (#369). A locked name
  // is an existing template's, which may predate the rule and still works.
  const nameInvalid = !nameLocked && !lockAll && templateNameProblem(meta.name) === "format";
  const nameMessageId = useId();
  const tagInputId = useId();

  return (
    <div className={`grid grid-cols-1 items-start gap-5 rounded-[12px] border bg-card p-5 sm:grid-cols-2 ${children ? "xl:grid-cols-4" : "lg:grid-cols-3"}`}>
      <label className="grid min-w-0 gap-2">
        <span className={fieldLabelClass}>{t("name")}</span>
        <Input
          placeholder={t("namePlaceholder")}
          value={meta.name}
          maxLength={TEMPLATE_NAME_MAX_LENGTH}
          disabled={nameLocked || lockAll}
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? nameMessageId : undefined}
          onChange={(e) => onChange({ ...meta, name: e.target.value })}
        />
      </label>
      <label className="grid min-w-0 gap-2">
        <span className={fieldLabelClass}>{t("displayName")}</span>
        <Input
          placeholder={t("displayName")}
          value={meta.display_name ?? ""}
          disabled={lockAll}
          onChange={(e) => onChange({ ...meta, display_name: e.target.value })}
        />
      </label>
      {!hideTeam && (
        <label className="grid min-w-0 gap-2">
          <span className={fieldLabelClass}>{t("team")}</span>
          <Input
              value={meta.team ?? ""}
            disabled={lockAll}
            onChange={(e) => onChange({ ...meta, team: e.target.value })}
          />
        </label>
      )}
      <div className="grid min-w-0 gap-2">
        <label htmlFor={lockAll ? undefined : tagInputId} className={fieldLabelClass}>{t("tags")}</label>
        <div className="flex flex-wrap items-center gap-2">
        {meta.tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 text-[11px]">
            {tag}
            {!lockAll && (
              <button
                type="button"
                aria-label={t("removeTag", { tag })}
                // A real icon at a real hit area (#44). "×" was a text glyph
                // whose size followed the badge's own font size, so it shrank
                // with it. The icon is 16px to fit the badge, but `after:`
                // stretches the pointer target to 24px for WCAG 2.2 SC 2.5.8 —
                // growing the button itself would grow the badge.
                //
                // ring, not outline: the parent Badge is `overflow-hidden`, and
                // an outline on a child flush with its edge gets clipped. A
                // ring is a box-shadow, which is not.
                className="relative -mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 after:absolute after:-inset-1 after:content-[''] hover:bg-secondary-foreground/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  onChange({
                    ...meta,
                    tags: meta.tags.filter((x) => x !== tag),
                  })
                }
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </Badge>
        ))}
        {!lockAll && (
          <Input
            id={tagInputId}
            placeholder={t("addTag")}
            className="min-w-28 flex-1"
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
      {children}
      {nameInvalid && (
        <p id={nameMessageId} className="col-span-full text-xs text-destructive">
          {t("nameInvalid")}
        </p>
      )}
    </div>
  );
}
