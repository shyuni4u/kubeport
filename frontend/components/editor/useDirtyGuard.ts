"use client";

import { useEffect, useRef } from "react";

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

/**
 * Settles `dirty` against what the editor started from, so undoing an edit
 * clears it (#274). Before, every edit handler set dirty and nothing ever
 * compared the text with the loaded one: type a line, delete it, and the
 * "저장하지 않은 변경 사항이 있습니다" mark and the leave prompt both stayed.
 *
 * `snapshot` is a string of everything a save would send, or null while the
 * editor is still loading; the first non-null value is the baseline. Edit
 * handlers may still mark dirty at once — this runs after the commit and puts
 * it back to "differs from the baseline", including when a handler fired
 * without changing anything (re-picking the same team).
 *
 * A successful save navigates away, and a mode switch remounts the editor,
 * which starts a new baseline; neither needs to move this one.
 */
export function useDirtyAgainstBaseline(
  snapshot: string | null,
  dirty: boolean,
  onDirty: (dirty: boolean) => void,
) {
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot === null) return;
    if (baseline.current === null) baseline.current = snapshot;
    const differs = snapshot !== baseline.current;
    if (differs !== dirty) onDirty(differs);
  }, [snapshot, dirty, onDirty]);
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
