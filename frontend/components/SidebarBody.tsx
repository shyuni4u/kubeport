import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClusterPicker } from "./ClusterPicker";
import { SidebarNavItem } from "./SidebarNavItem";
import type { Role } from "@/lib/role";

type NavKey = "catalog" | "myReleases" | "templates" | "releases" | "teams" | "overview" | "clusters" | "nodes" | "storage" | "network" | "help";

const NAV_BY_ROLE: Record<Role, Array<{ href: string; key: NavKey }>> = {
  user: [
    { href: "/", key: "overview" },
    { href: "/catalog", key: "catalog" },
    { href: "/releases", key: "myReleases" },
    { href: "/clusters", key: "clusters" },
    { href: "/storage", key: "storage" },
    { href: "/network", key: "network" },
    { href: "/help", key: "help" },
  ],
  admin: [
    { href: "/", key: "overview" },
    { href: "/catalog", key: "catalog" },
    { href: "/templates", key: "templates" },
    { href: "/releases", key: "releases" },
    { href: "/admin/teams", key: "teams" },
    { href: "/clusters", key: "clusters" },
    { href: "/nodes", key: "nodes" },
    { href: "/storage", key: "storage" },
    { href: "/network", key: "network" },
    { href: "/help", key: "help" },
  ],
};

export async function SidebarBody({ role, signedIn }: { role: Role; signedIn: boolean }) {
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
      {/* The picker lists clusters on mount, which needs a session. Without
          one it only earned a 401 in the console and "no clusters registered"
          for a visitor (#377), so it isn't mounted and nothing is requested.
          signedIn comes from the server, not from a failed fetch. */}
      {signedIn && (
        <div className="border-t border-sidebar-border p-4">
          <ClusterPicker />
        </div>
      )}
    </>
  );
}
