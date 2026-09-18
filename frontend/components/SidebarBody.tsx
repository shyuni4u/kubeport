import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ClusterPicker } from "./ClusterPicker";
import { SidebarNavItem } from "./SidebarNavItem";
import type { Role } from "@/lib/role";

export async function SidebarBody({ role, signedIn }: { role: Role; signedIn: boolean }) {
  const t = await getTranslations("shell.nav");
  return (
    <>
      <div className="flex h-14 items-center border-b border-sidebar-border px-6">
        <Link href="/" className="text-lg font-bold">
          kubeport
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {signedIn ? (
          <>
            <SidebarNavItem href="/" label={t("overview")} />
            <SidebarNavItem href="/catalog" label={t("catalog")} />
            <SidebarNavItem href="/releases" label={t(role === "admin" ? "releases" : "myReleases")} />
            {role === "admin" && (
              <div className="mt-5 space-y-1 border-t border-sidebar-border pt-4">
                <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{t("administration")}</p>
                <SidebarNavItem href="/templates" label={t("templates")} />
                <SidebarNavItem href="/admin/teams" label={t("teams")} />
                <SidebarNavItem href="/clusters" label={t("clusters")} beta />
              </div>
            )}
            <div className="mt-5 border-t border-sidebar-border pt-4">
              <SidebarNavItem href="/help" label={t("help")} />
            </div>
          </>
        ) : (
          <>
            <SidebarNavItem href="/" label={t("introduction")} />
            <SidebarNavItem href="/api/auth/login" label={t("login")} />
          </>
        )}
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
