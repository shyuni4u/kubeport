"use client";

import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "@/components/ui/resizable";

type Props = {
  tree: React.ReactNode;
  inspector: React.ReactNode;
  preview: React.ReactNode;
};

export function EditorLayout({ tree, inspector, preview }: Props) {
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-[calc(100vh-220px)] rounded-md border"
    >
      <ResizablePanel defaultSize={25} minSize={18}>
        <div className="h-full overflow-auto p-3">{tree}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={35} minSize={20}>
        <div className="h-full overflow-auto p-3">{inspector}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={40} minSize={25}>
        <div className="h-full overflow-auto">{preview}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
