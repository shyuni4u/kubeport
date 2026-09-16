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
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-3 py-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:py-0">
            <MobileSidebar role={role} signedIn={me !== null} />
            <div className="hidden sm:block sm:flex-1" />
            <div className="order-last flex basis-full flex-wrap items-center justify-end gap-2 sm:order-none sm:basis-auto sm:flex-nowrap sm:gap-3">
              <ErrorDetailSwitch />
              <ThemeSwitch initial={theme} />
              <LocaleSwitch />
            </div>
            <div className="flex min-w-0 flex-1 justify-end sm:flex-initial">
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
            </div>
          </header>
          {isDemoEmail(me?.email) && (
            <DemoBanner
              resetAtIso={
                nextResetAt(new Date(), process.env.DEMO_RESET_SCHEDULE)?.toISOString() ?? null
              }
            />
          )}
          <main className="min-w-0 flex-1">
            <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">{children}</div>
          </main>
        </div>
      </div>
      </ErrorDetailProvider>
    </KubeTermsProvider>
  );
}
