import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClusterPicker } from "./ClusterPicker";
import { SidebarNavItem } from "./SidebarNavItem";
import type { Role } from "@/lib/role";

type NavKey = "catalog" | "myReleases" | "templates" | "releases" | "teams";

const NAV_BY_ROLE: Record<Role, Array<{ href: string; key: NavKey }>> = {
  user: [
    { href: "/catalog", key: "catalog" },
    { href: "/releases", key: "myReleases" },
  ],
  admin: [
    { href: "/templates", key: "templates" },
    { href: "/releases", key: "releases" },
    { href: "/admin/teams", key: "teams" },
  ],
};

export async function SidebarBody({ role }: { role: Role }) {
  const t = await getTranslations("shell.nav");
  const nav = NAV_BY_ROLE[role];
  return (
    <>
      <div className="flex h-14 items-center border-b border-sidebar-border px-6">
        <Link href="/" className="text-lg font-bold">
          kubeport
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {nav.map((item) => (
          <SidebarNavItem key={item.href} href={item.href} label={t(item.key)} />
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-4">
        <ClusterPicker />
      </div>
    </>
  );
}
