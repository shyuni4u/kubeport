"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * "저장하지 않은 변경 사항이 있습니다" next to an editor's save button. Without it
 * the admin learned about pending edits only from the browser's leave prompt
 * (#146). Shared by BottomBar and the YAML version editor, which keeps its own
 * save button because "save as new version" is a label BottomBar cannot say.
 *
 * The live region stays mounted so screen readers hear the change when edits
 * start or a save clears them; the text is there only while dirty.
 */
export function UnsavedChangesStatus({ dirty }: { dirty?: boolean }) {
  const t = useTranslations("templates.editor");
  return (
    <span role="status" className="flex items-center gap-1.5 text-sm font-medium text-foreground">
      {dirty ? (
        <>
          <span aria-hidden className="size-2 rounded-full bg-amber-500" />
          {t("unsavedChanges")}
        </>
      ) : null}
    </span>
  );
}

type Props = {
  canSave: boolean;
  canPublish: boolean;
  /** The editor holds edits that are not saved yet (#146). */
  dirty?: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave: () => void;
  onPublish: () => void;
};

export function BottomBar({
  canSave,
  canPublish,
  dirty,
  saving,
  publishing,
  onSave,
  onPublish,
}: Props) {
  const t = useTranslations("templates.editor");
  return (
    <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t bg-white/90 px-4 py-3 backdrop-blur">
      <UnsavedChangesStatus dirty={dirty} />
      {/*
        Publishing lives on the template detail page (a new version always
        starts as a draft). Rather than a permanently greyed-out button that
        looks broken, tell the admin where publish happens.
      */}
      {!canPublish && (
        <span className="text-xs text-muted-foreground">{t("publishFromDetail")}</span>
      )}
      {/*
        Save stays enabled without edits, but it only takes the primary look
        while there is something to save, so the mark and the action point at
        the same place.
      */}
      <Button
        variant={dirty ? "default" : "outline"}
        onClick={onSave}
        disabled={!canSave || saving}
      >
        {saving ? t("saving") : t("saveDraft")}
      </Button>
      {canPublish && (
        <Button onClick={onPublish} disabled={publishing}>
          {publishing ? t("publishing") : t("publish")}
        </Button>
      )}
    </div>
  );
}
