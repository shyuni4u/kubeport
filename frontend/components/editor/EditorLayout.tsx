"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/lib/use-media-query";

type Props = {
  tree: React.ReactNode;
  inspector: React.ReactNode;
  preview: React.ReactNode;
  /**
   * Identifies the field the tree currently has selected, or null for none.
   * Only the narrow layout uses it, to follow a selection into the inspector
   * tab — without it, tapping a field on a phone appears to do nothing.
   */
  selection?: string | null;
};

/** Narrowest viewport that still gets three columns — Tailwind's `lg`. */
export const WIDE_LAYOUT_MIN_PX = 1024;
/**
 * What AppShell takes off the viewport before the panel group sees it:
 * Sidebar `w-60` (240px, shown from `md` up) plus the main container's `p-6`
 * on both sides (48px). react-resizable-panels sizes panels as a percentage of
 * the *group*, so the floor has to be computed against this, not the viewport.
 */
export const SHELL_CHROME_PX = 288;
/**
 * Spec §3.6 wants 220px per panel. 220 of (1024 − 288) = 736px is 29.9%, so 30.
 * Three of those come to 90%, leaving room to drag.
 *
 * This is also why the breakpoint is `lg` and not `md`: at 768px the group is
 * 480px, where 220px is 45.8% and three panels cannot coexist at all.
 */
export const MIN_PANEL_PERCENT = 30;

export function EditorLayout({ tree, inspector, preview, selection }: Props) {
  const wide = useMediaQuery(`(min-width: ${WIDE_LAYOUT_MIN_PX}px)`);

  // Deliberately one layout at a time rather than a `hidden lg:block` pair:
  // the preview panel holds a Monaco instance, and CSS-hiding the other branch
  // would still mount a second one. EditorLayout.test.tsx asserts that both
  // ways round, so the claim cannot quietly stop being true.
  return wide ? (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-[calc(100vh-220px)] rounded-md border"
    >
      <ResizablePanel defaultSize={30} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto p-3">{tree}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={35} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto p-3">{inspector}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={35} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto">{preview}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ) : (
    <NarrowLayout
      tree={tree}
      inspector={inspector}
      preview={preview}
      selection={selection}
    />
  );
}

function NarrowLayout({ tree, inspector, preview, selection }: Props) {
  const t = useTranslations("templates.editor.panels");
  const [tab, setTab] = useState("tree");

  // Follow the tree's selection into the inspector. Adjusting state during
  // render on a changed input is React's documented alternative to a setState
  // effect: it re-renders before anything is committed.
  const [lastSelection, setLastSelection] = useState(selection ?? null);
  if ((selection ?? null) !== lastSelection) {
    setLastSelection(selection ?? null);
    if (selection) setTab("inspector");
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="rounded-md border">
      <TabsList className="m-2">
        <TabsTrigger value="tree">{t("tree")}</TabsTrigger>
        <TabsTrigger value="inspector">{t("inspector")}</TabsTrigger>
        <TabsTrigger value="preview">{t("preview")}</TabsTrigger>
      </TabsList>
      {/*
        keepMounted on the two cheap panels: Base UI unmounts a hidden panel by
        default, and SchemaTree keeps its expanded set in local state, so
        stepping to the inspector and back collapsed the tree every time. The
        preview is left to unmount — it holds the Monaco instance this layout
        exists to mount only once.
      */}
      <TabsContent value="tree" keepMounted className="max-h-[60vh] overflow-auto p-3">
        {tree}
      </TabsContent>
      <TabsContent value="inspector" keepMounted className="max-h-[60vh] overflow-auto p-3">
        {inspector}
      </TabsContent>
      <TabsContent value="preview" className="max-h-[60vh] overflow-auto">
        {preview}
      </TabsContent>
    </Tabs>
  );
}
