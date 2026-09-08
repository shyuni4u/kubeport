"use client";

import { useEffect } from "react";

// Warns before the tab/window is closed or hard-navigated while the editor
// holds unsaved edits. Client-side `router.push` does not fire beforeunload,
// so mode switches are guarded separately with window.confirm.
export function useBeforeUnloadWhenDirty(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

// Returns the ui-spec path of the first exposed field whose label is blank,
// or null when every exposed field is labelled. `resources` is the editor's
// UI-mode state shape (kind + metadata.name + fields map).
export function findUnlabelledExposedField(
  resources: ReadonlyArray<{ kind: string; name: string; fields: Record<string, unknown> }>,
): string | null {
  for (const r of resources) {
    for (const [path, f] of Object.entries(r.fields)) {
      const field = f as { mode?: string; uiSpec?: { label?: string } } | undefined;
      if (field?.mode === "exposed" && !(field.uiSpec?.label ?? "").trim()) {
        return `${r.kind}[${r.name}].${path}`;
      }
    }
  }
  return null;
}
