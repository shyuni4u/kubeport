import { getTranslations } from "next-intl/server";
import { apiFetch } from "@/lib/api-server";
import { isDemoEmail } from "@/lib/demo";
import { nextResetAt } from "@/lib/demo-reset";
import { defaultErrorDetailLevel, resolveErrorDetailLevel } from "@/lib/error-detail";
import { roleFromGroups } from "@/lib/role";
import { DemoBanner } from "./DemoBanner";
import { ErrorDetailProvider } from "./ErrorDetailProvider";
import { ErrorDetailSwitch } from "./ErrorDetailSwitch";
import { KubeTermsProvider } from "./KubeTermsProvider";
import type { Theme } from "@/lib/theme";
import { LocaleSwitch } from "./LocaleSwitch";
import { ThemeSwitch } from "./ThemeSwitch";
import { MobileSidebar } from "./MobileSidebar";
import { Sidebar } from "./Sidebar";
import { TopBarUserMenu } from "./TopBarUserMenu";

export async function AppShell({
  children,
  theme,
  errorDetailCookie,
}: {
  children: React.ReactNode;
  theme: Theme;
  /** The raw `kbp_error_detail` cookie, if any (#6). */
  errorDetailCookie?: string;
}) {
  const me = await apiFetch("/v1/me")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  const t = await getTranslations("shell");
  const role = roleFromGroups(me?.groups ?? null);
  const email = me?.email ?? "…";
  // The viewer's choice, or where their role starts on this install (#6).
  // Resolved here, on the server, so the first paint and hydration agree.
  const errorDetail = resolveErrorDetailLevel(
    errorDetailCookie,
    defaultErrorDetailLevel({
      role,
      demo: isDemoEmail(me?.email),
      adminDefault: process.env.ERROR_DETAIL_ADMIN,
      userDefault: process.env.ERROR_DETAIL_USER,
    }),
  );

  return (
    // Every page's terms switch starts from this role, on the server too, so
    // an admin's reload paints raw terms first instead of flipping to them
    // at hydration (#247).
    <KubeTermsProvider isAdmin={role === "admin"}>
      <ErrorDetailProvider initial={errorDetail}>
      <div className="flex min-h-screen bg-background">
        <Sidebar role={role} signedIn={me !== null} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-6">
            <MobileSidebar role={role} signedIn={me !== null} />
            <div className="flex-1" />
            <ErrorDetailSwitch />
            <ThemeSwitch initial={theme} />
            <LocaleSwitch />
            {me ? (
              <TopBarUserMenu email={email} role={role} />
            ) : (
              <a
                href="/api/auth/login"
                className="rounded-md px-3 py-1 text-sm font-medium hover:bg-hover"
              >
                {t("login")}
              </a>
            )}
          </header>
          {isDemoEmail(me?.email) && (
            <DemoBanner
              resetAtIso={
                nextResetAt(new Date(), process.env.DEMO_RESET_SCHEDULE)?.toISOString() ?? null
              }
            />
          )}
          <main className="flex-1 overflow-auto">
            <div className="mx-auto w-full max-w-7xl p-6">{children}</div>
          </main>
        </div>
      </div>
      </ErrorDetailProvider>
    </KubeTermsProvider>
  );
}
