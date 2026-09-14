import { SidebarBody } from "./SidebarBody";
import type { Role } from "@/lib/role";

export function Sidebar({ role, signedIn }: { role: Role; signedIn: boolean }) {
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <SidebarBody role={role} signedIn={signedIn} />
    </aside>
  );
}
