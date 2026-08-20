"use client";

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
  return (
    <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t bg-white/90 px-4 py-3 backdrop-blur">
      <Button
        variant="outline"
        onClick={onSave}
        disabled={!canSave || saving}
      >
        {saving ? "저장 중…" : "Draft 저장"}
      </Button>
      <Button
        onClick={onPublish}
        disabled={!canPublish || publishing}
      >
        {publishing ? "퍼블리시 중…" : "Publish"}
      </Button>
    </div>
  );
}
