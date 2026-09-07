import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { isDemoEmail, nextResetAt } from "@/lib/demo";
import { roleFromGroups } from "@/lib/role";
import { DemoBanner } from "./DemoBanner";
import { LocaleSwitch } from "./LocaleSwitch";
import { MobileSidebar } from "./MobileSidebar";
import { Sidebar } from "./Sidebar";
import { TopBarUserMenu } from "./TopBarUserMenu";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const me = await apiFetch("/v1/me")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const t = await getTranslations("shell");
  const role = roleFromGroups(me?.groups ?? null);
  const email = me?.email ?? "…";

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-6">
          <MobileSidebar role={role} />
          <div className="flex-1" />
          <LocaleSwitch />
          {me ? (
            <TopBarUserMenu email={email} role={role} />
          ) : (
            <a
              href="/api/auth/login"
              className="rounded-md px-3 py-1 text-sm font-medium hover:bg-accent"
            >
              {t("login")}
            </a>
          )}
        </header>
        {isDemoEmail(me?.email) && (
          <DemoBanner resetAtIso={nextResetAt(new Date()).toISOString()} />
        )}
        <main className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-7xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
