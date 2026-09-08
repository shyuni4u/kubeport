"use client";

import { useEffect } from "react";

// Warns before leaving while the editor holds unsaved edits:
//  - tab close / reload / hard navigation → native beforeunload prompt
//  - in-app link clicks (sidebar, breadcrumbs, any <a href>) → window.confirm
//    with `leaveMessage`, in the capture phase so Next's <Link> never sees the
//    click when the user cancels
// Mode switches are guarded separately by the caller. Known gap: browser
// back/forward (popstate) cannot be cancelled in the App Router, so a history
// navigation still drops edits.
export function useBeforeUnloadWhenDirty(dirty: boolean, leaveMessage?: string) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to show the prompt.
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (!leaveMessage) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (anchor.href === window.location.href) return;
      if (!window.confirm(leaveMessage)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, leaveMessage]);
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
