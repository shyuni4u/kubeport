"use client";

import { useCallback, useEffect, useRef } from "react";

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
 * JSON with object keys sorted, so two states with the same content serialize
 * the same. Clearing a field and setting it again moves its key to the end of
 * the fields object; plain JSON.stringify then called the undone edit a change.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/**
 * Settles `dirty` against what the server holds, so undoing an edit clears it
 * (#274). Before, every edit handler set dirty and nothing ever compared the
 * text with the loaded one: type a line, delete it, and the "저장하지 않은 변경
 * 사항이 있습니다" mark and the leave prompt both stayed.
 *
 * `snapshot` is a string of everything a save would send (build it with
 * stableStringify), or null until the editor has what it loaded — all of it,
 * so the baseline is never a placeholder or an edit made mid-load. The first
 * non-null value is the baseline. Edit handlers may still mark dirty at once;
 * this runs after the commit and puts it back to "differs from the baseline",
 * including when a handler fired without changing anything (re-picking the
 * same team).
 *
 * Returns `markSaved(saved?)`: call it where a save lands, instead of
 * onDirty(false). The baseline becomes `saved` — or, without it, the snapshot
 * of the render the save started in, which is what was sent — and dirty is set
 * from whatever the editor holds now, so an edit or an undo made while the
 * request was out still counts. Pass `saved` when only part of a save landed,
 * as the snapshot of what the server holds now. A mode switch remounts the
 * editor, which starts a new baseline on its own.
 */
export function useDirtyAgainstBaseline(
  snapshot: string | null,
  dirty: boolean,
  onDirty: (dirty: boolean) => void,
): (saved?: string) => void {
  const baseline = useRef<string | null>(null);
  const latest = useRef<string | null>(snapshot);
  useEffect(() => {
    latest.current = snapshot;
    if (snapshot === null) return;
    if (baseline.current === null) baseline.current = snapshot;
    const differs = snapshot !== baseline.current;
    if (differs !== dirty) onDirty(differs);
  }, [snapshot, dirty, onDirty]);
  return useCallback(
    (saved?: string) => {
      const next = saved ?? snapshot;
      if (next === null) {
        onDirty(false);
        return;
      }
      baseline.current = next;
      onDirty(latest.current !== null && latest.current !== next);
    },
    [snapshot, onDirty],
  );
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
