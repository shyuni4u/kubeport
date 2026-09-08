"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

type Props = {
  canSave: boolean;
  canPublish: boolean;
  saving?: boolean;
  publishing?: boolean;
  onSave: () => void;
  onPublish: () => void;
};

export function BottomBar({
  canSave,
  canPublish,
  saving,
  publishing,
  onSave,
  onPublish,
}: Props) {
  const t = useTranslations("templates.editor");
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t bg-white/90 px-4 py-3 backdrop-blur">
      {/*
        Publishing lives on the template detail page (a new version always
        starts as a draft). Rather than a permanently greyed-out button that
        looks broken, tell the admin where publish happens.
      */}
      {!canPublish && (
        <span className="text-xs text-muted-foreground">{t("publishFromDetail")}</span>
      )}
      <Button
        variant="outline"
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
