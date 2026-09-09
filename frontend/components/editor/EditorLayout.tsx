"use client";

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
};

/**
 * Narrowest viewport that still gets three columns — Tailwind's `lg`.
 *
 * Not `md`: react-resizable-panels takes its minimum as a percentage of the
 * group, so the floor a panel can be dragged to is decided by the narrowest
 * viewport the layout runs at. Spec §3.6 wants 220px, and 220 of 768 is 28.6%
 * — three of those leaves 14% for the whole rest of the group. At 1024 the
 * same 220px is 21.5%, which fits three panels with room to drag (#45).
 */
export const WIDE_LAYOUT_MIN_PX = 1024;
/** 220px of WIDE_LAYOUT_MIN_PX, rounded up. EditorLayout.test.tsx pins both. */
export const MIN_PANEL_PERCENT = 22;

export function EditorLayout({ tree, inspector, preview }: Props) {
  const wide = useMediaQuery(`(min-width: ${WIDE_LAYOUT_MIN_PX}px)`);

  // Deliberately one layout at a time rather than a `hidden lg:block` pair:
  // the preview panel holds a Monaco instance, and CSS-hiding the other branch
  // would still mount a second one.
  return wide ? (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-[calc(100vh-220px)] rounded-md border"
    >
      <ResizablePanel defaultSize={25} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto p-3">{tree}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={35} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto p-3">{inspector}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={40} minSize={MIN_PANEL_PERCENT}>
        <div className="h-full overflow-auto">{preview}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ) : (
    <NarrowLayout tree={tree} inspector={inspector} preview={preview} />
  );
}

function NarrowLayout({ tree, inspector, preview }: Props) {
  const t = useTranslations("templates.editor.panels");
  return (
    <Tabs defaultValue="tree" className="rounded-md border">
      <TabsList className="m-2">
        <TabsTrigger value="tree">{t("tree")}</TabsTrigger>
        <TabsTrigger value="inspector">{t("inspector")}</TabsTrigger>
        <TabsTrigger value="preview">{t("preview")}</TabsTrigger>
      </TabsList>
      <TabsContent value="tree" className="max-h-[60vh] overflow-auto p-3">
        {tree}
      </TabsContent>
      <TabsContent value="inspector" className="max-h-[60vh] overflow-auto p-3">
        {inspector}
      </TabsContent>
      <TabsContent value="preview" className="max-h-[60vh] overflow-auto">
        {preview}
      </TabsContent>
    </Tabs>
  );
}
