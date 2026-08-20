import { getTranslations } from "next-intl/server";
import { MobileSidebarShell } from "./MobileSidebarShell";
import { SidebarBody } from "./SidebarBody";
import type { Role } from "@/lib/role";

export async function MobileSidebar({ role }: { role: Role }) {
  const t = await getTranslations("shell");
  return (
    <MobileSidebarShell triggerLabel={t("openMenu")}>
      <SidebarBody role={role} />
    </MobileSidebarShell>
  );
}
