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
   * Counts field selections in the tree. Only the narrow layout uses it, to
   * follow a selection into the inspector tab — without it, tapping a field on
   * a phone appears to do nothing.
   *
   * A count, not the selected field's identity: tapping the same field again is
   * still a request to see it, and an identity would compare equal and leave
   * the reader stranded on the tree tab.
   */
  selectionEvent?: number;
};

/** Keep three columns for large desktops; smaller workspaces use full-width tabs. */
export const WIDE_LAYOUT_MIN_PX = 1440;
/**
 * What AppShell takes off the viewport before the panel group sees it:
 * Sidebar `w-60` (240px, shown from `md` up) plus the main container's `p-6`
 * on both sides (48px). react-resizable-panels sizes panels as a percentage of
 * the *group*, so the floor has to be computed against this, not the viewport.
 */
export const SHELL_CHROME_PX = 288;
/** At 1440px, 30% of the workspace leaves at least 345px per panel. */
export const MIN_PANEL_PERCENT = 30;

export function EditorLayout({ tree, inspector, preview, selectionEvent }: Props) {
  const t = useTranslations("templates.editor.panels");
  const wide = useMediaQuery(`(min-width: ${WIDE_LAYOUT_MIN_PX}px)`);

  // Deliberately one layout at a time rather than a `hidden lg:block` pair:
  // the preview panel holds a Monaco instance, and CSS-hiding the other branch
  // would still mount a second one. EditorLayout.test.tsx asserts that both
  // ways round, so the claim cannot quietly stop being true.
  return wide ? (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-96 rounded-[12px] border bg-card"
      style={{ height: "65dvh" }}
    >
      <ResizablePanel defaultSize="30%" minSize={`${MIN_PANEL_PERCENT}%`}>
        <div className="h-full overflow-auto p-3"><h2 className="mb-4 border-b pb-3 text-sm font-semibold">{t("tree")}</h2>{tree}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="35%" minSize={`${MIN_PANEL_PERCENT}%`}>
        <div className="h-full overflow-auto p-3"><h2 className="mb-4 border-b pb-3 text-sm font-semibold">{t("inspector")}</h2>{inspector}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="35%" minSize={`${MIN_PANEL_PERCENT}%`}>
        <div className="h-full overflow-auto"><h2 className="mx-3 mb-1 mt-3 border-b pb-3 text-sm font-semibold">{t("preview")}</h2>{preview}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ) : (
    <NarrowLayout
      tree={tree}
      inspector={inspector}
      preview={preview}
      selectionEvent={selectionEvent}
    />
  );
}

function NarrowLayout({ tree, inspector, preview, selectionEvent = 0 }: Props) {
  const t = useTranslations("templates.editor.panels");
  const [tab, setTab] = useState("tree");

  // Follow the tree's selection into the inspector. Adjusting state during
  // render on a changed input is React's documented alternative to a setState
  // effect: it re-renders before anything is committed.
  const [lastEvent, setLastEvent] = useState(selectionEvent);
  if (selectionEvent !== lastEvent) {
    setLastEvent(selectionEvent);
    setTab("inspector");
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="rounded-[12px] border bg-card">
      <TabsList className="m-3">
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
